import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function publicPath(path) {
  if (
    /(?:^|[/\\])(?:\.env[^/\\]*|\.op-env[^/\\]*|\.envrc|\.git|\.ssh|\.aws)(?:[/\\]|$)/i.test(
      path,
    ) ||
    /\.(?:pem|key)$/i.test(path)
  ) {
    throw new Error('秘密情報を含みうるパスは入力にできません');
  }
}

function readPublicFile(path) {
  publicPath(path);
  publicPath(realpathSync(path));
  const info = statSync(path);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error('入力は 1 MiB 以下のファイルに限定してください');
  return readFileSync(path);
}

function readJson(path) {
  if (!path || !basename(path).endsWith('.json'))
    throw new Error('JSON ファイルを指定してください');
  return JSON.parse(readPublicFile(path).toString('utf8'));
}

function sourceLineCount(content) {
  const text = content.toString('utf8');
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function snapshotSources(root, sources) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 40) {
    throw new Error('根拠となるファイルを --source で 1〜40 件指定してください');
  }
  return [...new Set(sources)].sort().map((path) => {
    if (!nonempty(path) || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error('source は repo 内の相対パスにしてください');
    const absolute = resolve(root, path);
    publicPath(path);
    const actual = realpathSync(absolute);
    const within = relative(root, actual);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('repo 外の source は収集しません');
    const content = readPublicFile(absolute);
    if (content.includes(0)) throw new Error('binary は source にできません');
    return { path, sha256: digest(content), lines: sourceLineCount(content) };
  });
}

function contextIdentity(context) {
  if (
    !context ||
    !Number.isInteger(context.number) ||
    !['issue', 'pr'].includes(context.kind) ||
    !context.header?.url ||
    !context.routing
  ) {
    throw new Error('pnpm ctx <N> --json の出力を指定してください');
  }
  return digest(JSON.stringify(context));
}

/** Creates a draft; source contents and private session logs are never copied. */
export function createHandoff({ cwd = process.cwd(), context, sources }) {
  const contextId = contextIdentity(context);
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const headSha = git(root, ['rev-parse', 'HEAD']);
  if (context.kind === 'pr' && context.header.headSha !== headSha)
    throw new Error('PR head SHA と現在の HEAD が一致しません');
  const snapshot = { headSha, contextId, sources: snapshotSources(root, sources) };
  return {
    version: 1,
    snapshotId: digest(JSON.stringify(snapshot)),
    snapshot,
    issueUrl: context.header.url,
    status: 'draft',
    goal: context.header.title ?? '',
    acceptance: '',
    facts: [],
    hypotheses: [],
    unknowns: [],
    verification: [],
    nextAction: '',
  };
}

/** Validates freshness and evidence references, not truth or implementation safety. */
export function validateHandoff({ cwd = process.cwd(), context, handoff }) {
  try {
    if (
      handoff?.version !== 1 ||
      !handoff.snapshot ||
      digest(JSON.stringify(handoff.snapshot)) !== handoff.snapshotId
    ) {
      return { status: 'invalid', errors: ['snapshot の整合性がありません'] };
    }
    const current = createHandoff({
      cwd,
      context,
      sources: handoff.snapshot.sources.map((source) => source.path),
    });
    if (current.snapshotId !== handoff.snapshotId)
      return { status: 'stale', errors: ['HEAD・対象ファイル・ctx のいずれかが更新されています'] };
    const errors = [];
    if (handoff.issueUrl !== context.header.url)
      errors.push('引き継ぎ先 URL が ctx と一致しません');
    if (!['ready', 'partial'].includes(handoff.status)) errors.push('draft は引き継ぎ未完了です');
    for (const key of ['goal', 'acceptance', 'nextAction']) {
      if (!nonempty(handoff[key])) errors.push(`${key} が空です`);
    }
    for (const key of ['hypotheses', 'unknowns']) {
      if (!Array.isArray(handoff[key]) || handoff[key].some((item) => !nonempty(item)))
        errors.push(`${key} は空でない文字列の配列にしてください`);
    }
    if (!Array.isArray(handoff.facts) || handoff.facts.length === 0)
      errors.push('根拠付き facts が必要です');
    else
      for (const fact of handoff.facts) {
        const source = handoff.snapshot.sources.find((item) => item.path === fact?.path);
        if (
          !nonempty(fact?.claim) ||
          !source ||
          !Number.isInteger(fact.line) ||
          fact.line < 1 ||
          fact.line > source.lines
        ) {
          errors.push('fact には claim と snapshot 内の path・実在する行番号が必要です');
        }
      }
    if (!Array.isArray(handoff.verification) || handoff.verification.length === 0)
      errors.push('検証結果または未実行理由が必要です');
    else
      for (const check of handoff.verification) {
        if (
          !check ||
          !nonempty(check.command) ||
          !nonempty(check.output) ||
          !['passed', 'failed', 'not-run'].includes(check.status) ||
          (check.status === 'passed' && check.exitCode !== 0) ||
          (check.status === 'failed' &&
            (!Number.isInteger(check.exitCode) || check.exitCode === 0)) ||
          (check.status === 'not-run' && check.exitCode !== null)
        )
          errors.push('検証の command・output・status・exitCode が不整合です');
      }
    if (errors.length) return { status: 'invalid', errors };
    if (
      context.routing.ready !== true ||
      handoff.status === 'partial' ||
      handoff.unknowns.length > 0 ||
      handoff.verification.some((check) => check.status !== 'passed')
    ) {
      return {
        status: 'partial',
        errors: ['未確認事項・失敗・未実行を次の担当が確認してください'],
      };
    }
    return {
      status: 'ready',
      errors: [],
      note: '鮮度・形式の確認のみ。事実の正しさ、検証の実行、変更の安全性は証明していません',
    };
  } catch (error) {
    return {
      status: 'invalid',
      errors: [error instanceof Error ? error.message : '引き継ぎ資料を検査できません'],
    };
  }
}

function main(args) {
  const [mode, ...rest] = args;
  if (!['create', 'validate'].includes(mode))
    throw new Error('create または validate を指定してください');
  const options = { sources: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} の値がありません`);
    if (flag === '--source' && mode === 'create') options.sources.push(value);
    else if (flag === '--context') options.context = value;
    else if (flag === '--out' && mode === 'create') options.out = value;
    else if (flag === '--file' && mode === 'validate') options.file = value;
    else throw new Error(`未知の引数: ${flag}`);
  }
  const context = readJson(options.context);
  if (mode === 'create') {
    if (!options.out?.endsWith('.json')) throw new Error('--out <新規 JSON パス> が必要です');
    publicPath(resolve(options.out));
    const handoff = createHandoff({ context, sources: options.sources });
    writeFileSync(options.out, `${JSON.stringify(handoff, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ status: 'draft', file: options.out }));
  } else {
    const result = validateHandoff({ context, handoff: readJson(options.file) });
    console.log(JSON.stringify(result));
    if (result.status !== 'ready') process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '引き継ぎ処理が失敗しました');
    process.exitCode = 1;
  }
}
