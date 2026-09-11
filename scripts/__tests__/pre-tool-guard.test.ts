import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// security guard の test は、正常系の確認ではなく **敵対的な試行を先に列挙する**。
// 「許可すべき形が通る / 明らかに違う形が落ちる」だけを書くと、境界の 1 文字ずらし・
// 区切りの省略・類似名が抜ける。実際 2026-08-11 に guard の正規表現へ 2 回続けて
// 穴が空き（basename 判定、optional group による区切りの任意化）、どちらもこの
// file の test では捕まらず外部レビューが見つけた。判定を足す時は、
// まず「どう書けば通ってしまうか」を数え上げてから allow 側を書く。
//
// guard 実装側の対の教訓は「許可形を省略記法で組み立てず選択肢で列挙する」
// （scripts/hooks/pre-tool-guard-rules.mjs のコメント参照）。
//
// このファイルは scripts/__tests__/pre-tool-guard.test.ts（bash 版 guard の
// contract test）の Node/ESM 移植。各 describe/it の意図と assert は元ファイル
// と同一に保つ——変えたのは spawn 対象（bash loader → node loader）と、bash の
// 構文エラー・exit code を前提にしていた「script 自体の健全性」「loader/rules
// 分離」の 2 describe block だけ（Node の import 失敗・例外送出へ書き換えた）。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// pre-tool-guard.mjs は薄い loader（bash 版 #1961 の教訓を踏襲した Node/ESM
// 移植）。実際のロジックは pre-tool-guard-rules.mjs にある（settings.json の
// hooks 登録も同じ PR でこの loader へ切り替え済み。通常の test はすべて
// loaderPath 経由で書ける）。
const loaderPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard.mjs');
const rulesPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard-rules.mjs');

// path を組み立てるのは、この test file 自体を編集する Write が
// guard の file path 検査に引っかからないようにするため。
const HUMAN = `.op-env${'.'}human`;
const ADMIN_EXAMPLE = `${HUMAN}.example`;
const AGENT = `.op-env${'.'}agent`;
const LOCAL_EXAMPLE = `${AGENT}.example`;

const PROD_REF = `op://human/supabase/SUPABASE_SERVICE_ROLE_KEY`;
const AGENT_REF = `op://agent/supabase/SUPABASE_ACCESS_TOKEN`;

type Decision = 'block' | 'allow';

function runGuard(
  input: Record<string, unknown>,
  cwd: string = rootDir,
  env?: Record<string, string>,
): Decision {
  const result = spawnSync(process.execPath, [loaderPath], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: env ? { ...process.env, ...env } : process.env,
  });
  return result.status === 2 ? 'block' : 'allow';
}

function bash(command: string): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command } };
}

function mcp(toolName: string): Record<string, unknown> {
  return { tool_name: toolName, tool_input: { title: 'x', prompt: 'y' } };
}

// R1/R2（Agent の model 明示 + 探索への opus/fable 使用ガード）用ヘルパー。
function agentCall(
  input: Partial<{ model: string; subagent_type: string; prompt: string; description: string }>,
): Record<string, unknown> {
  return { tool_name: 'Agent', tool_input: { ...input } };
}

// R3（Read の範囲指定なし大規模ファイル読み込みガード）用ヘルパー。
function readTool(
  filePath: string,
  opts?: { offset?: number; limit?: number },
): Record<string, unknown> {
  return { tool_name: 'Read', tool_input: { file_path: filePath, ...opts } };
}

// setup が黙って失敗すると、以降の assert が「たまたま通る」形で緑になる。
// 失敗は即座に投げる。
function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

// 対象 path を commit して origin/main へ push し、`refs/remotes/origin/main` を生やす。
// migration ガードの「適用済み」判定はこの ref を見る（#2185）。
function commitAndPush(cwd: string, ...paths: string[]): void {
  git(['add', '--', ...paths], cwd);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'm'], cwd);
  git(['push', '-q', 'origin', 'HEAD:main'], cwd);
}

// commit だけして push しない（origin/main には載らない）。
function commitOnly(cwd: string, ...paths: string[]): void {
  git(['add', '--', ...paths], cwd);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'local'], cwd);
}

function write(filePath: string, content = ''): Record<string, unknown> {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

function edit(filePath: string, newString = ''): Record<string, unknown> {
  return { tool_name: 'Edit', tool_input: { file_path: filePath, new_string: newString } };
}

// #2334（同乗タスク、P3）: MultiEdit は edits[].new_string、NotebookEdit は
// new_source に書き込み内容が入る。impl の抽出 jq（WRITTEN 変数）が両方を
// 拾えていることを block 側で固定する。
function multiEdit(filePath: string, newStrings: string[]): Record<string, unknown> {
  return {
    tool_name: 'MultiEdit',
    tool_input: { file_path: filePath, edits: newStrings.map((new_string) => ({ new_string })) },
  };
}

function notebookEdit(notebookPath: string, newSource: string): Record<string, unknown> {
  return {
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: notebookPath, new_source: newSource },
  };
}

// guard 自体が壊れると全 tool がブロックされ、guard を直す編集まで塞がれる。
// bash 版は 2026-08-12 に実際に起きた（[[ ]] の中へ引用符入りの正規表現を
// 直接書いて構文エラーになり、Bash / Write / Edit がすべて拒否されて別
// セッションからの復旧が必要になった、#1961）。Node/ESM 版でも同じ class の
// 障害モードが起きる: `import()` は構文エラーを持つモジュールを読み込めない
// （import 自体が reject し、モジュール内のどんなコードも実行されない）。
// エディタ上の規律ではなく test で固定する。
describe('pre-tool-guard.mjs: script 自体の健全性', () => {
  it('loader の構文チェックを通る（node --check）', () => {
    const result = spawnSync(process.execPath, ['--check', loaderPath], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rules の構文チェックを通る（node --check）', () => {
    const result = spawnSync(process.execPath, ['--check', rulesPath], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

// #1961 の Node 移植: guard 自体（rules）が壊れた時、loader は fail closed を
// 既定にしつつ、**rules ファイル自身への Write/Edit だけ**を復旧目的で例外的に
// 通す。1 ファイル構成では自己検査コードごと構文エラーで実行されなくなるため、
// loader/rules の 2 ファイル分離だけがこの中間案を実装できる（bash 版 #1961
// コメント参照）。
//
// bash 版との対応: 「impl の構文エラー」→「rules の import 失敗」、
// 「impl の構文は健全だが非 0 exit」→「rules の import は成功するが evaluate()
// が例外を投げる」。loader はどちらも「import/評価に成功して decision が
// 'allow' の時だけ 0、それ以外は全部 2」という同じ fail-closed 規則で捌く。
describe('pre-tool-guard.mjs: loader/rules 分離（#1961 の Node 移植）', () => {
  let fixtureRoot: string;
  let healthyLoader: string;
  let degradedLoader: string;
  let degradedRules: string;
  let badExitLoader: string;
  let badExitRules: string;
  let renamedLoader: string;
  let renamedRules: string;
  let throwingDecisionLoader: string;
  let symlinkedLoader: string;
  let symlinkedRules: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-loader-'));

    // loader は import('./pre-tool-guard-rules.mjs') で自分と同じディレクトリの
    // rules を見る。rules は node 標準ライブラリ（node:child_process / node:fs /
    // node:path）しか import しない——復旧経路（rules 自身への Write だけ通す）が
    // repo 内 helper の破損で塞がらないようにするための不変条件なので、fixture も
    // loader + rules の 2 ファイルだけで組む。
    const healthyDir = join(fixtureRoot, 'healthy');
    mkdirSync(healthyDir);
    writeFileSync(join(healthyDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(join(healthyDir, 'pre-tool-guard-rules.mjs'), readFileSync(rulesPath, 'utf8'));
    healthyLoader = join(healthyDir, 'pre-tool-guard.mjs');

    const degradedDir = join(fixtureRoot, 'degraded');
    mkdirSync(degradedDir);
    writeFileSync(join(degradedDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    // 構文エラーを注入（未閉じの関数呼び出し）。2026-08-12 の bash 実障害
    // （未閉じの [[ ）と同型の「ファイル末尾が壊れている」形。
    writeFileSync(
      join(degradedDir, 'pre-tool-guard-rules.mjs'),
      `${readFileSync(rulesPath, 'utf8')}\nfunction __brokenSyntax(x {\n`,
    );
    degradedLoader = join(degradedDir, 'pre-tool-guard.mjs');
    degradedRules = join(degradedDir, 'pre-tool-guard-rules.mjs');

    const badExitDir = join(fixtureRoot, 'bad-exit');
    mkdirSync(badExitDir);
    writeFileSync(join(badExitDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    // import（構文）は健全だが、evaluate() が常に例外を投げる rules
    // （bash 版の「構文は健全だが実行時に想定外の非 0 を返す impl」の Node 版。
    // lib への相対 import が無くても import 自体は成立する最小 stub）。
    writeFileSync(
      join(badExitDir, 'pre-tool-guard-rules.mjs'),
      "export function evaluate() {\n  throw new Error('unexpected failure');\n}\n",
    );
    badExitLoader = join(badExitDir, 'pre-tool-guard.mjs');
    badExitRules = join(badExitDir, 'pre-tool-guard-rules.mjs');

    // import は成功するが `evaluate` が export されていない rules（編集中に export を
    // 落とした / 関数名を変えた形。Codex review P2、PR #2563）。import 失敗と同じ
    // 復旧経路に倒さないと、別セッション無しでは直せない。
    const renamedDir = join(fixtureRoot, 'renamed-export');
    mkdirSync(renamedDir);
    writeFileSync(join(renamedDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(
      join(renamedDir, 'pre-tool-guard-rules.mjs'),
      "export const renamedEvaluate = () => ({ decision: 'allow' });\n",
    );
    renamedLoader = join(renamedDir, 'pre-tool-guard.mjs');
    renamedRules = join(renamedDir, 'pre-tool-guard-rules.mjs');

    // evaluate() は返るが、その戻り値の参照（loader の `result.decision`）が例外を
    // 投げる rules。この参照は try の外側にあり、bash 版 loader が構造として持って
    // いた「0 か 2 以外を返さない」不変条件が Node では async 関数の未捕捉 rejection
    // = exit 1（harness では block ではなく non-blocking error）へ落ちる。exit 1 に
    // なると guard が判定を下せなかった操作が素通りするため fail closed が崩れる
    // （#2563 内製クロスレビュー P2）。
    const throwingDecisionDir = join(fixtureRoot, 'throwing-decision');
    mkdirSync(throwingDecisionDir);
    writeFileSync(
      join(throwingDecisionDir, 'pre-tool-guard.mjs'),
      readFileSync(loaderPath, 'utf8'),
    );
    writeFileSync(
      join(throwingDecisionDir, 'pre-tool-guard-rules.mjs'),
      "export function evaluate() {\n  return Object.defineProperty({}, 'decision', {\n    get() {\n      throw new Error('unexpected failure after evaluate');\n    },\n  });\n}\n",
    );
    throwingDecisionLoader = join(throwingDecisionDir, 'pre-tool-guard.mjs');

    // path の途中に symlink がある配置。ESM の `import.meta.url` は realpath を返す
    // 一方 harness が渡す `file_path` は解決されていないため、素の文字列比較では
    // 復旧経路が常に block へ落ちる（macOS の tmpdir は `/var` -> `/private/var` で
    // 実際にこの形。#2563 内製クロスレビュー P2、Linux CI では tmpdir が symlink で
    // ないため素通りしていた）。symlink を明示的に作って両 OS で固定する。
    const symlinkTargetDir = join(fixtureRoot, 'symlink-target');
    mkdirSync(symlinkTargetDir);
    writeFileSync(join(symlinkTargetDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(
      join(symlinkTargetDir, 'pre-tool-guard-rules.mjs'),
      `${readFileSync(rulesPath, 'utf8')}\nfunction __brokenSyntax(x {\n`,
    );
    const symlinkDir = join(fixtureRoot, 'symlink-alias');
    symlinkSync(symlinkTargetDir, symlinkDir, 'dir');
    symlinkedLoader = join(symlinkDir, 'pre-tool-guard.mjs');
    symlinkedRules = join(symlinkDir, 'pre-tool-guard-rules.mjs');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runVia(loaderFixturePath: string, input: Record<string, unknown>): Decision {
    const result = spawnSync(process.execPath, [loaderFixturePath], {
      cwd: rootDir,
      encoding: 'utf8',
      input: JSON.stringify(input),
    });
    return result.status === 2 ? 'block' : 'allow';
  }

  it('rules が健全なら loader は通常どおり委譲する（stdin forward が正しい）', () => {
    expect(runVia(healthyLoader, write('/x/.op-env.human'))).toBe('allow');
    expect(runVia(healthyLoader, write('/x/.env'))).toBe('block');
    expect(runVia(healthyLoader, bash('git status'))).toBe('allow');
  });

  it('rules が構文エラー（import 失敗）の時、無関係な Bash 操作は fail closed', () => {
    expect(runVia(degradedLoader, bash('git status'))).toBe('block');
  });

  it('rules が構文エラーの時、rules 以外への Write/Edit は fail closed', () => {
    expect(runVia(degradedLoader, write('/x/notes.md'))).toBe('block');
  });

  it('rules が構文エラーの時、rules ファイル自身への Write/Edit だけは復旧目的で通る', () => {
    expect(runVia(degradedLoader, write(degradedRules))).toBe('allow');
    expect(runVia(degradedLoader, edit(degradedRules))).toBe('allow');
  });

  it('loader 自身への Write は例外対象外（fail closed のまま）', () => {
    expect(runVia(degradedLoader, write(degradedLoader))).toBe('block');
  });

  it('rules の構文は健全でも evaluate() が例外を投げたら fail closed（exit code を 2 へ写す）', () => {
    expect(runVia(badExitLoader, bash('git status'))).toBe('block');
  });

  it('evaluate が export されていない（import は成功）時、無関係な操作は fail closed で rules 自身への Write/Edit だけ通る', () => {
    expect(runVia(renamedLoader, bash('git status'))).toBe('block');
    expect(runVia(renamedLoader, write('/x/notes.md'))).toBe('block');
    expect(runVia(renamedLoader, write(renamedRules))).toBe('allow');
    expect(runVia(renamedLoader, edit(renamedRules))).toBe('allow');
  });

  it('path の途中が symlink でも、rules 自身への Write/Edit の復旧経路は働く', () => {
    expect(runVia(symlinkedLoader, write(symlinkedRules))).toBe('allow');
    expect(runVia(symlinkedLoader, edit(symlinkedRules))).toBe('allow');
    // 例外は rules 自身に限る。symlink 経由でも他 path は fail closed のまま
    expect(runVia(symlinkedLoader, write(join(dirname(symlinkedRules), 'notes.md')))).toBe('block');
  });

  it('try の外側で例外が起きても exit 1 ではなく 2 を返す（loader は 0 か 2 以外を返さない）', () => {
    const result = spawnSync(process.execPath, [throwingDecisionLoader], {
      cwd: rootDir,
      encoding: 'utf8',
      input: JSON.stringify(bash('git status')),
    });
    expect(result.status).toBe(2);
  });

  it('evaluate() が例外を投げる時も、rules 自身への Write/Edit だけは復旧目的で通る', () => {
    expect(runVia(badExitLoader, write('/x/notes.md'))).toBe('block');
    expect(runVia(badExitLoader, write(badExitRules))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: .op-env.human', () => {
  // .op-env.human は op:// 参照だけで実秘密を含まない。2026-08-13、User 決定
  // （#1993）で境界を「読み書き可・消費のみ禁止」へ変更した。作成・Write/Edit は
  // 解禁し、op run で production の service role key を解決する消費だけを止める。
  it.each([
    ['雛形からのコピー', `cp ${ADMIN_EXAMPLE} ${HUMAN}`],
    ['リダイレクトでの作成', `cat > ${HUMAN}`],
    ['追記', `echo x >> ${HUMAN}`],
    ['touch', `touch ${HUMAN}`],
    ['セパレータ後の cp', `pnpm i && cp a ${HUMAN}`],
  ])('作成は通す（#1993）: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('allow');
  });

  it('Write / Edit でも作成・編集を通す（#1993）', () => {
    expect(runGuard(write(`/x/${HUMAN}`))).toBe('allow');
    expect(runGuard(edit(`/x/${HUMAN}`))).toBe('allow');
  });

  // 作成を解禁しても、雛形をそのまま op run に渡せば同じ権限が解決される。
  // コマンド名ではなく --env-file の指す先で判定するので、op をどう起動しても落ちる。
  it.each([
    [
      '雛形の直接実行',
      `op run --env-file=${ADMIN_EXAMPLE} -- bash scripts/runbook/admin-delete-user.sh`,
    ],
    ['実ファイル', `op run --env-file=${HUMAN} -- bash scripts/runbook/admin-show-user.sh`],
    ['空白区切りの --env-file', `op run --env-file ${ADMIN_EXAMPLE} -- sh -c true`],
    ['セパレータ後の op run', `cd /tmp && op run --env-file=${ADMIN_EXAMPLE} -- sh -c true`],
    [
      'env 経由',
      `env op run --env-file=${ADMIN_EXAMPLE} -- bash scripts/runbook/admin-delete-user.sh`,
    ],
    ['command 経由', `command op run --env-file=${ADMIN_EXAMPLE} -- sh -c true`],
    ['絶対パス', `/opt/homebrew/bin/op run --env-file=${ADMIN_EXAMPLE} -- sh -c true`],
    ['sh -c でくるむ', `sh -c "op run --env-file=${ADMIN_EXAMPLE} -- sh -c true"`],
    ['環境変数代入を前置', `FOO=1 op run --env-file=${ADMIN_EXAMPLE} -- sh -c true`],
    ['xargs 経由', `echo x | xargs -I{} op run --env-file=${ADMIN_EXAMPLE} -- sh -c true`],
  ])('op run による消費を止める: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it.each([
    ['通常 local dev の op run', `op run --env-file=${AGENT} -- pnpm env:check`],
    ['雛形の読み取り', `cat ${ADMIN_EXAMPLE}`],
    ['名前の grep', `rg -n ${HUMAN} docs/`],
    ['local の作り直し', `cp ${LOCAL_EXAMPLE} ${AGENT}`],
    ['無関係コマンド', 'git status'],
  ])('正当な操作は通す: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('allow');
  });

  it('雛形と local の編集は通す', () => {
    expect(runGuard(write(`/x/${ADMIN_EXAMPLE}`))).toBe('allow');
    expect(runGuard(edit(`/x/${AGENT}`))).toBe('allow');
  });

  // 引数で判定する代償として、この flag と path を並べた文字列を Bash 引数へ
  // 含めるだけでも落ちる。docs に書く時は Write/Edit で file に書いてから渡す。
  // 迂回形を数え上げる方式では env / command / 絶対パス / sh -c と際限がないため、
  // 誤検知を受け入れて class ごと閉じる方を選んでいる。
  it('flag と path を並べた文字列は、引用符の中でも落とす', () => {
    const mention = `gh pr edit 1935 --body 'op run --env-file=${ADMIN_EXAMPLE} -- bash x.sh で本番権限が解決される'`;
    expect(runGuard(bash(mention))).toBe('block');
  });

  // 禁止 path を数え上げる方式は、雛形を別名へ複製されると破れる
  // （cp .op-env.human.example /tmp/foo → その別名を op run へ）。
  // path 名から中身は判別できないので allowlist にして、中身を問わず落とす。
  it.each([
    [
      '別名へ複製した env-file',
      'op run --env-file=/tmp/foo -- bash scripts/runbook/admin-delete-user.sh',
    ],
    ['相対の別名', 'op run --env-file=./tmp-env -- sh -c true'],
    ['変数展開', 'op run --env-file="$OP_ENV_PATH" -- sh -c true'],
    ['local の雛形', `op run --env-file=${LOCAL_EXAMPLE} -- sh -c true`],
    // 「path らしくない token は無視する」例外を置くと、escape を含む path が
    // 検査対象から外れて空白入りの別名で迂回できた。分類せず落とす。
    [
      '空白を escape した別名',
      'op run --env-file=/tmp/foo\\ bar -- bash scripts/runbook/admin-delete-user.sh',
    ],
    ['引用符で囲んだ別名', 'op run --env-file="/tmp/foo bar" -- sh -c true'],
    // basename で判定すると、任意ディレクトリに同名で置くだけで通ってしまう。
    // path 文字列そのものを allowlist にして塞ぐ。
    [
      '別ディレクトリの同名ファイル',
      'op run --env-file=/tmp/.op-env.agent -- bash scripts/runbook/admin-delete-user.sh',
    ],
    ['home 配下の同名ファイル', 'op run --env-file=~/.op-env.agent -- sh -c true'],
    ['深い相対 path の同名ファイル', 'op run --env-file=../../../tmp/.op-env.agent -- sh -c true'],
    // 許可形を optional group で組み立てると区切りの / が任意になり、
    // 下のような類似名まで通る。省略記法を使わず選択肢で列挙する。
    [
      '区切りなしの類似名',
      'op run --env-file=..op-env.agent -- bash scripts/runbook/admin-delete-user.sh',
    ],
    ['ドットを増やした類似名', 'op run --env-file=../...op-env.agent -- sh -c true'],
    ['1 階層だけ上の同名ファイル', 'op run --env-file=../.op-env.agent -- sh -c true'],
    // 旧名は移行猶予中 disk に残りうるが、消費は改名時点で許可 literal から
    // 外れている。この block を契約として固定する（#2095 クロスレビュー P2）
    ['旧名 .op-env.local の消費', `op run --env-file=.op-env${'.'}local -- pnpm env:check`],
    ['旧名 .op-env.admin の消費', `op run --env-file=.op-env${'.'}admin -- sh -c true`],
    // bash は実行前に `\` + 改行を除去するため、複数行に整形しただけで
    // 行単位の grep は分断される。敵対的な回避ではなく通常の整形で起きる。
    [
      '行継続で分断した flag',
      `op run --env-file\\\n=${ADMIN_EXAMPLE} -- bash scripts/runbook/admin-delete-user.sh`,
    ],
    ['行継続で分断した path', `op run --env-file=\\\n${ADMIN_EXAMPLE} -- sh -c true`],
  ])('許可外の env-file を落とす: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it.each([
    ['repo root の local', `op run --env-file=${AGENT} -- pnpm typecheck`],
    ['明示的な ./ 付き', `op run --env-file=./${AGENT} -- pnpm typecheck`],
    ['workspace からの相対 local', `op run --env-file=../../${AGENT} -- pnpm typecheck`],
  ])('許可された env-file は通す: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('allow');
  });

  // 判定は fail closed。token を分類して例外を作ると、そこが穴になる
  // （escape を含む path が「path らしくない」として素通りした）。
  // 代償として散文も落ちる。docs に書く時は Write/Edit で file へ書いてから渡す。
  it('散文で flag に言及しただけでも落とす（fail closed の代償）', () => {
    const prose = 'git commit -m "--env-file に渡してよいのは通常の local だけにする"';
    expect(runGuard(bash(prose))).toBe('block');
  });

  it('flag を伴わない名前の言及は通す', () => {
    expect(
      runGuard(bash(`gh pr edit 1935 --body '${ADMIN_EXAMPLE} は production を参照する'`)),
    ).toBe('allow');
  });

  // #1993 の受け入れ条件: 「agent が admin ファイルに書ける = 消費できる」では
  // ないことを、書いた直後の消費が落ちることで固定する。
  it('書いた直後の消費は落ちる（作成解禁は消費解禁ではない）', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-admin-'));
    try {
      expect(runGuard(write(join(fixtureRoot, HUMAN), `A=${PROD_REF}`))).toBe('allow');
      writeFileSync(join(fixtureRoot, HUMAN), `A=${PROD_REF}`);
      expect(runGuard(bash(`op run --env-file=${HUMAN} -- sh -c true`), fixtureRoot)).toBe('block');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

// #1953: regex でコマンド文字列を見る限り shell の引数解釈は再現できない。
// 「flag に一致したら後続 token を照合する」2 段構えは、トリガーに一致しない
// 書き方が照合にすら入らず素通りする。判定を「-env-file の言及が **すべて**
// 許可形か」に変え、変形を個別に数え上げるのをやめた。
describe('pre-tool-guard.mjs: flag 自体の書き換え', () => {
  it.each([
    // quote は shell が引数から取り除くので、= の前後どこへ刺しても argv は同じ。
    // 旧実装はトリガーの --env-file[=空白] に一致せず素通りしていた。
    [
      '= の前に二重引用符',
      `op run --env-file"=${HUMAN}" -- bash scripts/runbook/admin-delete-user.sh`,
    ],
    ['= の前に単引用符', `op run --env-file'='${HUMAN} -- bash scripts/runbook/admin-show-user.sh`],
    ['= を backslash escape', `op run --env-file\\=${HUMAN} -- sh -c true`],
    // flag 名の内側に刺す形は生の文字列に -env-file が現れない。
    // quote / backslash を除いた写しでのみ捕まる。
    ['flag 名の内側に二重引用符', `op run --env-f"ile"=${HUMAN} -- sh -c true`],
    ['flag 名の内側に単引用符', `op run --env-'file'=${HUMAN} -- sh -c true`],
    // ANSI-C / locale 形式の quote も shell が引数から取り除く。導入の $ を
    // 落としてから通常の quote 除去に合流させないと、どちらの写しにも
    // -env-file が現れない。
    ['ANSI-C quote で flag を分断', `op run --env-fi$'le'=${HUMAN} -- sh -c true`],
    ['locale quote で flag を分断', `op run --env-fi$"le"=${HUMAN} -- sh -c true`],
    // = が無い形・変数が挟まる形も「許可形ではない言及」として落ちる。
    [
      'flag と = の間に変数',
      'op run --env-file${X}=/tmp/evil -- bash scripts/runbook/admin-delete-user.sh',
    ],
    // 許可形が 1 つあっても、許可外の言及が混ざれば落ちる。
    [
      '許可形のあとに許可外の flag',
      `op run --env-file=${AGENT} --env-file=/tmp/evil -- sh -c true`,
    ],
    // 引用符を挟んで token の途中に空白を作る形。生の文字列側の検査で落ちる。
    ['許可 literal に引用符を混ぜる', `op run --env-file="${AGENT}"" /tmp/evil" -- sh -c true`],
  ])('落とす: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  // 受け入れる代償。閉じ引用符が続く形を除外する例外は置かない
  // （同型の例外が過去 2 回穴になっている）。回避策は leading dash を外すこと。
  it('flag の直後に引用符が来る自己検索も落ちる（受け入れる誤検知）', () => {
    expect(runGuard(bash(`rg -- '--env-file' scripts/hooks/`))).toBe('block');
  });

  it('leading dash を外した検索は通る（誤検知の回避策）', () => {
    expect(runGuard(bash('rg env-file scripts/hooks/'))).toBe('allow');
  });
});

// #1944: heredoc 本文も危険コマンド検査の対象に**残す**（誤検知を受け入れる）。
//
// 「本文はデータだから外す」を実装したが、**どの行が本当に heredoc を開いていて
// 本文がどこへ行くのかは、shell の引用状態とコマンド位置を解釈しないと決まらない。**
// 外部レビュー 3 巡で 4 通りの取りこぼしが実測で見つかり、いずれも変更前は
// ブロックできていた形が通るようになる方向だった。下の block ケース群は、
// その実測で見つかった形をそのまま回帰テストとして残したもの。
//
// force-push / reset ガードは agent 自身の逸脱を止めるためのもので、ブロック側の
// 後退は P3 の誤検知より重い。誤検知（コミットメッセージに文字列を書くと落ちる）は
// 受け入れて docs に書く。判断の記録は scripts/hooks/pre-tool-guard-rules.mjs のコメントと
// #1944 のコメント。
describe('pre-tool-guard.mjs: heredoc 本文と危険コマンド', () => {
  const heredoc = (intro: string, body: string, delim = 'EOF') => `${intro}\n${body}\n${delim}`;

  // 受け入れる誤検知。回避策は文面を変えるか、Write / Edit で file へ書いてから渡す。
  it.each([
    [
      'commit message 本文での言及',
      heredoc(
        "git commit -F - <<'EOF'",
        'fix: guard\n\ngit push --no-verify を禁止する規約に触れた',
      ),
    ],
    ['cat のリダイレクト', heredoc('cat <<EOF > /tmp/note.md', 'git push --force は禁止')],
    ['reset --hard の言及', heredoc("git commit -F - <<'EOF'", 'docs: git reset --hard の注意')],
  ])('本文での言及も落ちる（受け入れる誤検知）: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it.each([
    ['素の force push', 'git push --force origin main'],
    ['素の no-verify', 'git push --no-verify'],
    ['セパレータ後の no-verify', 'pnpm check && git push --no-verify'],
    ['sh -c でくるむ force', 'sh -c "git push --force"'],
    ['素の reset --hard', 'git reset --hard origin/main'],
    // 以下は heredoc 除外を実装した時に「通るようになっていた」形。除外を
    // やめたので素直に落ちる。除外を再導入するなら、まずここが緑のままかを見る。
    ['heredoc を bash へ食わせる', heredoc('bash <<EOF', 'git push --no-verify')],
    ['cat heredoc を bash へ pipe', heredoc('cat <<EOF | bash', 'git reset --hard')],
    ['eval + heredoc', 'eval "$(cat <<\'EOF\'\ngit push --no-verify\nEOF\n)"'],
    ['コマンド置換 + heredoc', 'x=$(cat <<EOF\ngit reset --hard\nEOF\n)'],
    ['プロセス置換', 'bash <(cat <<EOF\ngit push --no-verify\nEOF\n)'],
    [
      '導入行の ; で後続実行',
      'cat <<EOF > /tmp/run.sh; bash /tmp/run.sh\ngit push --force origin main\nEOF',
    ],
    // consumer 名が実行コマンドではなく引数の位置にある形。実際は bash が stdin を実行する
    [
      'bash -s に consumer 名を混ぜる',
      heredoc('bash -s git <<EOF', 'git push --force origin main'),
    ],
    // 引用符やコメントの中の << は heredoc ではない。次行は普通に実行される
    ['引用文字列の中の <<EOF', 'echo "x cat <<EOF"\ngit push --force origin main\nEOF'],
    ['コメント内の <<EOF', '# cat <<EOF\ngit push --force origin main\nEOF'],
    ['heredoc の後続行', `${heredoc("git commit -F - <<'EOF'", 'msg')}\ngit push --no-verify`],
    ['here-string の後の実コマンド', 'cat <<< "x"; git push --no-verify'],
  ])('実コマンドは落とす: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it('--force-with-lease は通す', () => {
    expect(runGuard(bash('git push --force-with-lease origin main'))).toBe('allow');
  });
});

// #1949: path の allowlist は「どのファイルか」しか見ない。許可 path の中身へ
// production 参照を書き足せば、path トリックなしで production credential に届く。
// 中身は op:// の vault で判定し、許可 vault 以外を落とす。
describe('pre-tool-guard.mjs: env-file の中身', () => {
  let fixtureRoot: string;
  let cleanDir: string;
  let prodDir: string;
  let emptyDir: string;
  let nestedDir: string;

  beforeAll(() => {
    // fixture を tmp に置くのは、実環境の .op-env.agent の有無で結果が変わらない
    // ようにするため（main checkout には実ファイルがあり、worktree には無い）。
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-'));
    cleanDir = join(fixtureRoot, 'clean');
    prodDir = join(fixtureRoot, 'prod');
    emptyDir = join(fixtureRoot, 'empty');
    nestedDir = join(prodDir, 'apps', 'product');
    mkdirSync(cleanDir);
    mkdirSync(prodDir);
    mkdirSync(emptyDir);
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(cleanDir, AGENT),
      ['A=' + AGENT_REF, 'B=op://agent/resend/RESEND_API_KEY', 'C=op://agent/supabase/URL'].join(
        '\n',
      ),
    );
    writeFileSync(join(prodDir, AGENT), ['A=' + AGENT_REF, 'B=' + PROD_REF].join('\n'));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('許可 vault だけの env-file は通す', () => {
    expect(runGuard(bash(`op run --env-file=${AGENT} -- pnpm typecheck`), cleanDir)).toBe('allow');
  });

  it('production 参照を含む env-file は落とす', () => {
    expect(runGuard(bash(`op run --env-file=${AGENT} -- pnpm typecheck`), prodDir)).toBe('block');
  });

  it('./ 形でも中身を見る', () => {
    expect(runGuard(bash(`op run --env-file=./${AGENT} -- sh -c true`), prodDir)).toBe('block');
  });

  it('workspace からの相対形でも中身を見る', () => {
    expect(runGuard(bash(`op run --env-file=../../${AGENT} -- pnpm typecheck`), nestedDir)).toBe(
      'block',
    );
  });

  // quote を除いた写しにしか -env-file が現れない形。path の抽出も言及の検出も
  // 生の写しだけを見ていた時、この形は中身検査にも単一コマンド制約にも載らず、
  // production 参照を持つ env-file をそのまま解決できていた。
  it('flag 名の内側に引用符があっても中身を見る', () => {
    expect(runGuard(bash(`op run --env-f"ile"=${AGENT} -- sh -c true`), prodDir)).toBe('block');
  });

  // ANSI-C quote は生の写しにも通常の quote 除去後の写しにも -env-file を
  // 残さない。$ を落としてから合流させないと、中身検査まで素通りする。
  it('ANSI-C quote で分断された flag でも中身を見る', () => {
    expect(runGuard(bash(`op run --env-fi$'le'=${AGENT} -- sh -c true`), prodDir)).toBe('block');
  });

  // 存在しない file は「解決される参照が無い」ので通す。op run 側が失敗する。
  it('env-file が存在しなければ通す', () => {
    expect(runGuard(bash(`op run --env-file=${AGENT} -- pnpm typecheck`), emptyDir)).toBe('allow');
  });

  // hook は Bash 呼び出しごとに実行前 1 回しか発火しないので、同一コマンド内で
  // 書き換えられると上の中身検査は書き換え前を読む。検査した中身と実際に解決
  // される中身が別物になるため、そういう余地のあるコマンド形自体を落とす。
  //
  // 書き手を列挙する方式では閉じない。列挙（cp / mv / tee / sed / リダイレクト）を
  // 実装した時点で python3 / node / `>|` がすり抜けることを実測した。区切りと
  // コマンド置換という「別のことが起きる余地」の方を落とす。
  it.each([
    [
      '追記してから消費',
      `echo 'X=${PROD_REF}' >> ${AGENT} && op run --env-file=${AGENT} -- sh -c true`,
    ],
    [
      '雛形コピー直後に消費',
      `cp ${LOCAL_EXAMPLE} ${AGENT} && op run --env-file=${AGENT} -- pnpm typecheck`,
    ],
    ['sed -i してから消費', `sed -i '' s/a/b/ ${AGENT}; op run --env-file=${AGENT} -- sh -c true`],
    ['tee してから消費', `echo x | tee ${AGENT} && op run --env-file=${AGENT} -- sh -c true`],
    // 列挙方式をすり抜けた書き手たち
    [
      'python3 で追記してから消費',
      `python3 -c "open('${AGENT}','a').write('X=${PROD_REF}')" && op run --env-file=${AGENT} -- sh -c true`,
    ],
    [
      'node で追記してから消費',
      `node -e "require('fs').appendFileSync('${AGENT}','X=${PROD_REF}')" && op run --env-file=${AGENT} -- sh -c true`,
    ],
    [
      'awk で書いてから消費',
      `awk 'BEGIN{print "X" > "${AGENT}"}' && op run --env-file=${AGENT} -- sh -c true`,
    ],
    // >| は > の別形。除外文字クラスに | を入れていたリダイレクト検出をすり抜けた
    [
      '>| で上書きしてから消費',
      `echo 'X=${PROD_REF}' >| ${AGENT} && op run --env-file=${AGENT} -- sh -c true`,
    ],
    // 改行も区切り。COMMAND_JOINED は改行を空白へ寄せるので、生の文字列側で見る
    [
      '改行で繋いだ書き換え + 消費',
      `echo 'X=${PROD_REF}' >> ${AGENT}\nop run --env-file=${AGENT} -- sh -c true`,
    ],
    // コマンド置換の中に書き手を隠す形
    ['コマンド置換を含む消費', `op run --env-file=${AGENT} -- sh -c "$(printf x)"`],
    // cd は中身検査の path 解決をずらす。同じ規則で落ちる
    ['cd してから消費', `cd /tmp && op run --env-file=${AGENT} -- sh -c true`],
    // 言及の検出を生の写しだけで行っていた時、この形は制約から外れていた
    ['flag 名の内側に引用符 + 区切り', `cd /tmp && op run --env-f"ile"=${AGENT} -- sh -c true`],
    ['プロセス置換を含む消費', `op run --env-file=${AGENT} -- diff <(echo a) <(echo b)`],
  ])('env-file の消費は単一の単純コマンドに限る: %s', (_label, command) => {
    expect(runGuard(bash(command), cleanDir)).toBe('block');
  });

  it('書き換えだけなら通す（消費は次のコマンドで検査される）', () => {
    expect(runGuard(bash(`echo 'X=${AGENT_REF}' >> ${AGENT}`), cleanDir)).toBe('allow');
  });

  // 発生源でも止める。実行時の検査は agent が op run を直接打つ場面でしか
  // 発火しない（pnpm typecheck:op などは npm script の内側で op run するので
  // hook からは見えない）ため、書き足し自体をここで落とす。
  it.each([
    ['Write に production 参照', write(`/x/${AGENT}`, `A=${PROD_REF}`)],
    ['Edit に production 参照', edit(`/x/${AGENT}`, `A=${PROD_REF}`)],
    ['雛形へ production 参照', write(`/x/${LOCAL_EXAMPLE}`, `A=${PROD_REF}`)],
    ['未知の vault', write(`/x/${AGENT}`, 'A=op://Dayopt-Prod/supabase/KEY')],
    // 旧名は User の手動移行まで disk に残りうる。消費は allowlist で落ちるが、
    // 書き込みの発生源検査も移行猶予として旧名を対象に残す（#2086 反証レビュー）
    ['旧名 .op-env.local への許可外 vault 参照', write(`/x/.op-env${'.'}local`, `A=${PROD_REF}`)],
    // #2334（同乗タスク、P3）: MultiEdit/NotebookEdit を判定対象に含めた時点
    // （非ブロッキング Codex レビュー P1 是正）で、抽出 jq（WRITTEN 変数）に
    // edits[].new_string / new_source を足さないと「未検査で通る新経路」に
    // なる。ロジックは実装済みだが、これまで block 側の回帰テストが無かった
    // （手動トレースのみで正当性確認していた）ため固定する。
    ['MultiEdit に production 参照', multiEdit(`/x/${AGENT}`, [`A=${PROD_REF}`])],
    ['NotebookEdit に production 参照', notebookEdit(`/x/${AGENT}`, `A=${PROD_REF}`)],
  ])('書き込み時にも落とす: %s', (_label, input) => {
    expect(runGuard(input)).toBe('block');
  });

  it.each([
    ['Write に staging 参照', write(`/x/${AGENT}`, `A=${AGENT_REF}`)],
    ['Edit に local 参照', edit(`/x/${AGENT}`, 'A=op://agent/supabase/URL')],
    // admin 雛形は設計上 production を参照する。ここを落とすと schema 更新ができない。
    ['admin 雛形への production 参照', write(`/x/${ADMIN_EXAMPLE}`, `A=${PROD_REF}`)],
    // env-file 以外への言及は対象外（docs に vault 名を書けなくなる）
    ['docs への言及', write('/x/notes.md', `${PROD_REF} を参照する運用`)],
  ])('正当な書き込みは通す: %s', (_label, input) => {
    expect(runGuard(input)).toBe('allow');
  });
});

// #1986: 書き込み時検査は「書き込まれるテキスト」だけを見る。op:// を含まない
// 部分置換の Edit（vault 名だけの差し替え）はこの層をすり抜ける。
//
// これは regression ではなく、既知の受け入れ済みギャップとして固定する。権威は
// 実行時層（op run 直前に実ファイルを読む）で、書き込み時はあくまで early
// feedback の best-effort。境界は docs/operations/secrets.md L58 に記載済み。
// (a) 適用後の文字列再構成、(b) PostToolUse での事後検査はどちらも見送った
// （(a) は bash の literal 置換が壊れやすく静かな fail open になりうる、
// (b) は権威層が既にこのケースを捕まえるため複雑さに見合わない）。
describe('pre-tool-guard.mjs: 部分置換の Edit（#1986、受け入れる既知のギャップ）', () => {
  it('op:// を含まない部分置換 Edit は書き込み時検査を通る（権威は実行時層）', () => {
    expect(runGuard(edit(`/x/${AGENT}`, 'human'))).toBe('allow');
  });
});

// #1987: 単一コマンド判定は文字単位なので、引用済み引数の中の区切り記号でも
// 落ちる。「env-file 言及より前だけを判定範囲にする」narrowing 案は、
// コマンド置換が位置によらず先に評価される点は分離できても、区切り文字が
// quote の中かどうかは追えないままで、#1944（heredoc）と同型の
// 「shell の引用状態は regex で再現できない」という結論に当たる。
// 確信が持てない narrowing は行わず、過剰ブロックを維持する。
describe('pre-tool-guard.mjs: 引用済み引数内の区切り記号（#1987、受け入れる誤検知）', () => {
  it('op run の子プロセス引数に quote された | があっても落ちる', () => {
    expect(runGuard(bash(`op run --env-file=${AGENT} -- node -e "console.log('a|b')"`))).toBe(
      'block',
    );
  });
});

// #1959: チップ起票（spawn_task）は Main（main checkout の session）の専権。レーンが直接 User へ
// チップを出すと triage の判断が User に飛ぶ。レーンは issue 化 + Main へ
// send_message に一本化する（dispatch skill（旧 orchestration.md、#2479 で再編） §レーンの連絡規律）。
describe('pre-tool-guard.mjs: レーンからのチップ起票', () => {
  const SPAWN = 'mcp__ccd_session__spawn_task';
  let fixtureRoot: string;
  let mainDir: string;
  let worktreeDir: string;
  let plainDir: string;

  beforeAll(() => {
    // 判定は git の linked worktree かどうか。実環境の worktree に依存させると
    // CI（plain clone）で結果が変わるので、fixture で両方を作る。
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-git-'));
    mainDir = join(fixtureRoot, 'main');
    worktreeDir = join(fixtureRoot, 'lane');
    plainDir = join(fixtureRoot, 'plain');
    mkdirSync(mainDir);
    mkdirSync(plainDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    git(['worktree', 'add', '-q', worktreeDir, '-b', 'lane'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('linked worktree からは落とす', () => {
    expect(runGuard(mcp(SPAWN), worktreeDir)).toBe('block');
  });

  it('main checkout からは通す（Main の着手する issue の選択は正規手段）', () => {
    expect(runGuard(mcp(SPAWN), mainDir)).toBe('allow');
  });

  // 判定は「Main だと言い切れた時だけ通す」allowlist。git が使えない・repo 外は
  // 落とす。`cd ""` は bash では成功してカレントに留まるため、空値を素通りさせると
  // 両者が同じ cwd に解決されて「一致＝Main」と誤判定する（実装中に踏んだ）。
  it('git 管理外のディレクトリからは落とす（fail closed）', () => {
    expect(runGuard(mcp(SPAWN), plainDir)).toBe('block');
  });

  // path の慣習（.claude/worktrees/ 配下）で判定していないことの裏取り。
  // fixture の worktree は慣習の外にあるが、それでも落ちる。
  it('慣習外の場所にある worktree でも落とす', () => {
    expect(worktreeDir).not.toContain('.claude/worktrees');
    expect(runGuard(mcp(SPAWN), worktreeDir)).toBe('block');
  });

  it.each([
    ['章立て', 'mcp__ccd_session__mark_chapter'],
    ['Main への連絡', 'mcp__ccd_session_mgmt__send_message'],
  ])('worktree でも他の tool は通す: %s', (_label, toolName) => {
    expect(runGuard(mcp(toolName), worktreeDir)).toBe('allow');
  });
});

// worktree 外ファイル編集ガード（2026-08-24, #2359）。
// レーンは自分の worktree 外を書き換えない（AGENTS.md §委任・報告の作法
// の writer 4 条件）。判定は guard_resolve_roots()（spawn_task 判定と共用）を
// working tree root ベースで行うため、fixture は main + 2 linked worktree で組む。
describe('pre-tool-guard.mjs: worktree 外ファイル編集ガード（#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneADir: string;
  let laneBDir: string;
  let plainDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-boundary-'));
    mainDir = join(fixtureRoot, 'main');
    laneADir = join(fixtureRoot, 'laneA');
    laneBDir = join(fixtureRoot, 'laneB');
    plainDir = join(fixtureRoot, 'plain');
    mkdirSync(mainDir);
    mkdirSync(plainDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    git(['worktree', 'add', '-q', laneADir, '-b', 'laneA'], mainDir);
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('自分の worktree 内への Write は許可する', () => {
    expect(runGuard(write(join(laneADir, 'foo.ts')), laneADir)).toBe('allow');
  });

  it('他レーンの worktree への Write は block する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), laneADir)).toBe('block');
  });

  it('他レーンの worktree への Edit も block する', () => {
    expect(runGuard(edit(join(laneBDir, 'foo.ts')), laneADir)).toBe('block');
  });

  it('他レーンの worktree への MultiEdit も block する', () => {
    expect(runGuard(multiEdit(join(laneBDir, 'foo.ts'), ['x']), laneADir)).toBe('block');
  });

  it('".." traversal で他レーンへ抜ける形も block する（prefix 比較のすり抜け対策）', () => {
    expect(runGuard(write(join(laneADir, '..', 'laneB', 'foo.ts')), laneADir)).toBe('block');
  });

  it('相対パスの file_path は block する（tool 仕様への依存を guard としては信頼しない）', () => {
    expect(runGuard(write('relative/foo.ts'), laneADir)).toBe('block');
  });

  it('repo 外（scratchpad 相当、存在しないディレクトリ）への Write は許可する', () => {
    const outside = join(fixtureRoot, 'outside-not-yet-created', 'foo.md');
    expect(runGuard(write(outside), laneADir)).toBe('allow');
  });

  it('自分の worktree 内の未存在サブディレクトリへの Write は許可する（新規ディレクトリ作成を壊さない）', () => {
    expect(runGuard(write(join(laneADir, 'new', 'nested', 'foo.ts')), laneADir)).toBe('allow');
  });

  it('main checkout から自分自身への Write は許可する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), mainDir)).toBe('allow');
  });

  it('main checkout から他レーンの worktree への Write は block する（Main はコードを書かない）', () => {
    expect(runGuard(write(join(laneADir, 'foo.ts')), mainDir)).toBe('block');
  });

  it('git 管理外のディレクトリでは fail-open（Write/Edit は高頻度操作のため）', () => {
    expect(runGuard(write('/tmp/anywhere/foo.ts'), plainDir)).toBe('allow');
  });
});

// symlink 経由の別名で保護境界が外れないこと（2026-09-05, #2566）。
//
// 保護判定（.env 系 / 既存 migration / local dev env-file）が **生の file_path の
// 文字列一致**だった頃は、`ln -s .env tmp/foo` のように保護対象を指す symlink を
// 1 本置けば、basename が `.env` で終わらないので判定を素通りし、書き込みは実体の
// `.env` へ着地した。`.env` / `.env.local` は AGENTS.md §Non-Negotiables で
// 「読みも書きもしない」と定めた境界で、その機械強制が symlink 1 本で外れていた。
//
// fixture は worktree 境界ガードを通すために git repo として作る（repo 外への
// Write は worktree 境界の側で落ちてしまい、保護判定を証明できないため）。
// 「無関係な symlink は allow のまま」も併せて固定し、誤検知が増えていないことを示す。
describe('pre-tool-guard.mjs: symlink 経由の保護ファイル判定（#2566）', () => {
  let fixtureRoot: string;
  let repoDir: string;
  let migrationPath: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-symlink-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );
    // migration 判定は origin/main 基準になった（#2185）。この describe が証明したいのは
    // 「symlink 別名でも保護判定が外れない」ことなので、origin/main 不在による
    // fail-closed で block が出る状態にはしない（それでは symlink 解決が壊れても緑になる）。
    const remoteDir = join(fixtureRoot, 'remote.git');
    git(['init', '-q', '--bare', remoteDir], fixtureRoot);
    git(['remote', 'add', 'origin', remoteDir], repoDir);

    // 実体（保護対象）
    writeFileSync(join(repoDir, '.env'), 'SECRET=1\n');
    writeFileSync(join(repoDir, '.env.local'), 'SECRET=2\n');
    writeFileSync(join(repoDir, AGENT), '');
    writeFileSync(join(repoDir, 'notes.md'), '');
    mkdirSync(join(repoDir, 'supabase', 'migrations'), { recursive: true });
    migrationPath = join(repoDir, 'supabase', 'migrations', '20260101000000_init.sql');
    writeFileSync(migrationPath, 'select 1;\n');
    commitAndPush(repoDir, 'supabase/migrations/20260101000000_init.sql');

    // 保護対象を指す別名（basename からは保護対象と分からない形）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(join(repoDir, '.env'), join(repoDir, 'tmp', 'alias-a'), 'file');
    symlinkSync(join(repoDir, '.env.local'), join(repoDir, 'tmp', 'alias-b'), 'file');
    symlinkSync(join(repoDir, AGENT), join(repoDir, 'tmp', 'alias-c'), 'file');
    symlinkSync(migrationPath, join(repoDir, 'tmp', 'alias-d'), 'file');
    symlinkSync(join(repoDir, 'notes.md'), join(repoDir, 'tmp', 'alias-e'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('直接 path での .env / .env.local への Write は従来どおり block（回帰確認）', () => {
    expect(runGuard(write(join(repoDir, '.env')), repoDir)).toBe('block');
    expect(runGuard(write(join(repoDir, '.env.local')), repoDir)).toBe('block');
  });

  it('.env を指す symlink への Write を block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-a')), repoDir)).toBe('block');
  });

  it('.env.local を指す symlink への Write を block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-b')), repoDir)).toBe('block');
  });

  it('.env を指す symlink への Edit / MultiEdit / NotebookEdit も block する', () => {
    const alias = join(repoDir, 'tmp', 'alias-a');
    expect(runGuard(edit(alias), repoDir)).toBe('block');
    expect(runGuard(multiEdit(alias, ['x']), repoDir)).toBe('block');
    expect(runGuard(notebookEdit(alias, 'x'), repoDir)).toBe('block');
  });

  it('local dev env-file を指す symlink でも許可外 vault の op:// 参照は block する', () => {
    const alias = join(repoDir, 'tmp', 'alias-c');
    // 直接 path と同じ挙動になること（許可 vault なら通り、production 参照なら落ちる）
    expect(runGuard(write(alias, `A=${AGENT_REF}\n`), repoDir)).toBe('allow');
    expect(runGuard(write(alias, `A=${PROD_REF}\n`), repoDir)).toBe('block');
  });

  it('origin/main に載っている migration を指す symlink への Write も block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-d')), repoDir)).toBe('block');
  });

  it('保護対象でないファイルを指す symlink は allow のまま（誤検知を増やしていない）', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-e')), repoDir)).toBe('allow');
  });

  it('symlink でない通常ファイルへの Write は allow のまま', () => {
    expect(runGuard(write(join(repoDir, 'notes.md')), repoDir)).toBe('allow');
    expect(runGuard(write(join(repoDir, 'new', 'nested', 'foo.ts')), repoDir)).toBe('allow');
  });
});

// 逆向きの symlink（保護対象の**名前**が非保護名の実体を指す）(#2566 の 2 巡目レビュー P2)。
//
// #2566 の修正を「raw path の判定を canonical path の判定へ**置き換える**」形で書くと、
// `.env` / `.env.local` 自身を symlink にしている checkout（env を 1 箇所へ集約する構成）で、
// 実体側の名前が保護パターンに当たらないため `.env` への Write が素通りする。
// 判定は raw と canonical の**両方**で行う（どちらかが当たれば block）。
//
// `.claude/settings.json` の `permissions.deny` は `Read(**/.env*)` しか持たず Write を
// 塞いでいないため、AGENTS.md §Non-Negotiables の書き込み禁止はこの guard が唯一の強制。
describe('pre-tool-guard.mjs: 保護対象の名前が非保護名の実体を指す symlink（#2566）', () => {
  let fixtureRoot: string;
  let repoDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-reverse-symlink-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );

    // 実体は保護対象の名前を持たない
    mkdirSync(join(repoDir, 'secrets'));
    writeFileSync(join(repoDir, 'secrets', 'dev-config'), 'SECRET=1\n');
    writeFileSync(join(repoDir, 'secrets', 'creds'), 'SECRET=2\n');
    symlinkSync(join(repoDir, 'secrets', 'dev-config'), join(repoDir, '.env'), 'file');
    symlinkSync(join(repoDir, 'secrets', 'creds'), join(repoDir, '.env.local'), 'file');

    // dangling symlink（実体がまだ存在しない `.env` を指す別名）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(join(repoDir, 'not-created-yet', '.env'), join(repoDir, 'tmp', 'dangling'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('.env 自体が非保護名の実体を指す symlink でも Write を block する', () => {
    expect(runGuard(write(join(repoDir, '.env')), repoDir)).toBe('block');
  });

  it('.env.local 自体が非保護名の実体を指す symlink でも Write を block する', () => {
    expect(runGuard(write(join(repoDir, '.env.local')), repoDir)).toBe('block');
  });

  it('実体が未作成の .env を指す dangling symlink への Write も block する', () => {
    // realpathSync は途中で ENOENT になると何も返さないため、lstat + readlink で
    // 手で辿らないと link 先が見えず素通りする。
    expect(runGuard(write(join(repoDir, 'tmp', 'dangling')), repoDir)).toBe('block');
  });

  it('実体（非保護名）へ直接書くのは allow のまま（誤検知を増やしていない）', () => {
    expect(runGuard(write(join(repoDir, 'secrets', 'dev-config')), repoDir)).toBe('allow');
  });
});

// nested 配置（このリポジトリの実際の運用: worktree は main の配下の
// `.claude/worktrees/<name>` に nested される）専用の fixture。
// merge 前クロスレビュー risk-reviewer 指摘: sibling 配置の fixture（上の
// describe）だけでは「Main（CURRENT_ROOT = 家系の親）から見ると、他
// レーンのパスも $GUARD_CURRENT_ROOT/* に該当してしまい先に許可側へ倒れる」
// class を検出できない。longest-prefix-match で修正済み（guard_path_belongs_to_current_root）。
describe('pre-tool-guard.mjs: worktree 外ファイル編集ガード（nested 配置、#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneBDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-nested-'));
    mainDir = join(fixtureRoot, 'main');
    laneBDir = join(mainDir, '.claude', 'worktrees', 'laneB');
    mkdirSync(mainDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    mkdirSync(join(mainDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('main checkout から自分自身への Write は許可する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), mainDir)).toBe('allow');
  });

  it('main checkout から nested な他レーンへの Write は block する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), mainDir)).toBe('block');
  });

  it('nested レーンから自分自身への Write は許可する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), laneBDir)).toBe('allow');
  });

  it('nested レーンから main への Write は block する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), laneBDir)).toBe('block');
  });
});

// rm -rf 系（2026-08-24, #2359）。危険なシェイプの列挙（他 worktree 名を数え
// 上げる等）ではなく、worktree 外へ抜けうる対象の指標（絶対パス起動・`~`・
// 変数展開・`..`）で判定する（AGENTS.md §PR / git 運用 §同型指摘の打ち切り
// 「denylist をやめて allowlist にする」）。worktree 内で完結する日常的な
// キャッシュ削除は通す。
describe('pre-tool-guard.mjs: rm -rf 系（#2359）', () => {
  it.each([
    ['rm -rf node_modules', 'rm -rf node_modules'],
    ['rm -rf .next', 'rm -rf .next'],
    ['rm -rf apps/product/.next tsbuildinfo', 'rm -rf apps/product/.next tsbuildinfo'],
    ['非recursive の rm', 'rm /tmp/foo'],
  ])('worktree 内で完結する形は通す: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('allow');
  });

  it.each([
    ['".." traversal', 'rm -rf ../other-lane'],
    ['".." のみ', 'rm -rf ..'],
    ['$HOME 参照', 'rm -rf $HOME/Desktop'],
    ['~ 参照', 'rm -rf ~/Desktop/dayopt/apps'],
    ['変数展開', 'rm -rf $VAR'],
    ['-r（force なし）でも traversal なら block', 'rm -r ../other-lane'],
    ['同一 segment 内の変数展開（区切りあり）', 'rm -rf $VAR && echo hi'],
  ])('worktree 外を指しうる対象は block する: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('block');
  });

  it('binary path 前置（/bin/rm）+ 相対パス target は通す', () => {
    expect(runGuard(bash('/bin/rm -rf .next'))).toBe('allow');
  });

  // 回帰テスト（DoD 動作確認中に自己検出）: escape-target 判定をコマンド全体で
  // 見ると、rm と無関係な別 segment の `$` が誤って block を引き起こしていた
  // （`rm -rf <安全な相対パス> && echo "done: $?"` が block される事故）。
  // 判定は rm を含む segment（; & | で区切った 1 文）に限定する。
  it('rm と無関係な別 segment の $ では誤 block しない（絶対パス、family 外）', () => {
    expect(runGuard(bash('rm -rf /tmp/scratch-dir && echo "done: $?"'))).toBe('allow');
  });

  it('rm と無関係な別 segment の $ では誤 block しない（安全な相対パス）', () => {
    expect(runGuard(bash('rm -rf .next && echo "done: $?"'))).toBe('allow');
  });
});

// rm -rf の絶対パス target と家系判定（2026-08-24, #2359）。
// merge 前クロスレビュー P2 是正: block メッセージは「相対パスのみ許可」と
// 宣言していたのに実装は絶対パスを見ておらず素通りしていた。
// 直後の risk-reviewer 指摘: 単純な「絶対パスは全部 block」だと scratchpad
// 掃除（family 外の絶対パス）まで壊れる。guard_resolve_roots の家系 root と
// 突合し、**自分以外の worktree root に属する時だけ** block する。
describe('pre-tool-guard.mjs: rm -rf の絶対パス target（家系判定、#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneBDir: string;
  let outsideDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-rm-abs-'));
    mainDir = join(fixtureRoot, 'main');
    laneBDir = join(mainDir, '.claude', 'worktrees', 'laneB');
    outsideDir = join(fixtureRoot, 'scratchpad-like');
    mkdirSync(mainDir);
    mkdirSync(outsideDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    mkdirSync(join(mainDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('family 外（scratchpad 相当）の絶対パスへの rm -rf は許可する', () => {
    expect(runGuard(bash(`rm -rf ${outsideDir}/subdir`), mainDir)).toBe('allow');
  });

  it('自分自身の絶対パスへの rm -rf は許可する', () => {
    expect(runGuard(bash(`rm -rf ${mainDir}/node_modules`), mainDir)).toBe('allow');
  });

  it('main checkout から nested な他 worktree への絶対パス rm -rf は block する', () => {
    expect(runGuard(bash(`rm -rf ${laneBDir}`), mainDir)).toBe('block');
  });

  it('レーンから main への絶対パス rm -rf は block する', () => {
    expect(runGuard(bash(`rm -rf ${mainDir}`), laneBDir)).toBe('block');
  });
});

// supabase db reset の生呼び出し block（2026-08-24, #2359）。ローカル Supabase
// は複数 worktree セッションが共有する単一インスタンスのため、reset は他
// レーンの進行中データも巻き戻す。CLAUDE.md Commands に明記された既定コマンド
// （pnpm db:reset / db:fresh）は対象外にし、生の CLI 呼び出しだけを block する。
describe('pre-tool-guard.mjs: supabase db reset の生呼び出し（#2359）', () => {
  it.each([
    ['supabase db reset', 'supabase db reset'],
    ['npx 経由', 'npx supabase db reset --local'],
    // pnpm exec / pnpm dlx（merge 前クロスレビュー P3 是正: npx を列挙した
    // 以上、同じ粒度の兄弟実行ラッパーだけ抜けているのは片手落ち）
    ['pnpm exec 経由', 'pnpm exec supabase db reset'],
    ['pnpm dlx 経由', 'pnpm dlx supabase db reset'],
  ])('生の CLI 呼び出しは block する: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('block');
  });

  it.each([
    ['pnpm db:reset', 'pnpm db:reset'],
    ['pnpm db:fresh', 'pnpm db:fresh'],
  ])('既定コマンド（pnpm wrapper）は通す: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('allow');
  });
});

// git commit --no-verify（2026-08-24, #2359）。pre-commit に gitleaks が乗った
// ため、既存の git push --no-verify block を commit にも拡張する。短縮形 `-n`
// は tail -n / grep -n 等との誤検知リスクが高いため対象外にする
// （既存の --no-verify トレードオフとは非対称）。
describe('pre-tool-guard.mjs: git commit --no-verify（#2359）', () => {
  it('長形式 --no-verify は block する', () => {
    expect(runGuard(bash('git commit -m "x" --no-verify'))).toBe('block');
  });

  it('短縮形 -n は意図的に対象外（既知のギャップ）', () => {
    expect(runGuard(bash('git commit -n'))).toBe('allow');
  });

  it('コミットメッセージ本文の "-n" 相当の文字列で誤検知しない', () => {
    expect(runGuard(bash('git commit -m "tail -n 5 output"'))).toBe('allow');
  });

  it('git push -n（dry-run、別意味）は対象外のまま', () => {
    expect(runGuard(bash('git push -n origin main'))).toBe('allow');
  });

  it('git push --no-verify は既存どおり block する（回帰確認）', () => {
    expect(runGuard(bash('git push --no-verify origin foo'))).toBe('block');
  });
});

// #2293: agent-ops secret 露出の出力段 redaction。過去 4 件の露出 incident
// （07-22 Vercel CLI token / 08-11 Supabase branches credential / 08-11
// Turnstile secret via Management API ×2）はいずれも「生表示 command を
// denylist keyword や部分一致フィルタで塞ごうとして漏れた」class。本節は
// denylist の穴埋めではなく、危険な command shape そのものを block し、
// field allowlist projection を持つ安全な代替（scripts/agent/supabase-mgmt-safe-get.mjs
// 等）へ一本化する構造の contract を固定する。
describe('pre-tool-guard.mjs: #2293 op item get の --reveal / --format=json', () => {
  it('--reveal を伴うと落ちる（concealed field の実値が出力される）', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password --reveal'))).toBe('block');
  });

  it('--format=json を伴うと --reveal なしでも落ちる（1Password CLI は --reveal と無関係に .value へ実値を含める仕様）', () => {
    expect(runGuard(bash('op item get "human/supabase" --format=json'))).toBe('block');
  });

  it('--format json（空白区切り）でも落ちる', () => {
    expect(runGuard(bash('op item get "human/supabase" --format json'))).toBe('block');
  });

  it('OP_FORMAT=json 環境変数指定でも落ちる', () => {
    expect(runGuard(bash('OP_FORMAT=json op item get "human/supabase"'))).toBe('block');
  });

  it('quote された --reveal でも落ちる（raw+unquoted 2 写し評価）', () => {
    expect(runGuard(bash(`op item get 'human/supabase' --fields password '--reveal'`))).toBe(
      'block',
    );
  });

  it('既定の human-readable 形式・--reveal なしは通す（concealed field は masked のまま出る）', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password'))).toBe('allow');
  });

  it('存在確認（--vault のみ）は通す', () => {
    expect(runGuard(bash('op item get "human/supabase" --vault human'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: #2293 supabase branches get（08-11 incident 再現）', () => {
  it('08-11 incident の実行形（--experimental branches get）は落ちる', () => {
    expect(runGuard(bash('supabase --experimental branches get efqkuihquhzhuhnwvffk'))).toBe(
      'block',
    );
  });

  it('安全な代替（branches list）は通す', () => {
    expect(runGuard(bash('supabase --experimental branches list'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: #2293 vercel --token / -t（07-22 incident 再現）', () => {
  it('--token に値を伴う vercel 呼び出しは落ちる', () => {
    expect(runGuard(bash('vercel ls --token abc123'))).toBe('block');
  });

  it('短縮形 -t でも落ちる', () => {
    expect(runGuard(bash('vercel ls -t abc123'))).toBe('block');
  });

  it('等号結合形（--token=）でも落ちる', () => {
    expect(runGuard(bash('vercel ls --token=abc123'))).toBe('block');
  });

  it('&& で連結した先でも落ちる（コマンド先頭以外の位置）', () => {
    expect(runGuard(bash('echo hi && vercel ls --token abc123'))).toBe('block');
  });

  it('token を渡さない vercel 呼び出しは通す', () => {
    expect(runGuard(bash('vercel ls'))).toBe('allow');
  });

  it('無関係なコマンドの -t flag は落とさない（vercel 呼び出しでない）', () => {
    expect(runGuard(bash('tar -t -f archive.tar'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: #2293 Supabase Management API secret endpoint（08-11 incident 再現 ×2）', () => {
  it('08-11 incident 1 の実行形（config/auth への直接 curl）は落ちる', () => {
    expect(
      runGuard(
        bash(
          'curl -s "https://api.supabase.com/v1/projects/ref/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"',
        ),
      ),
    ).toBe('block');
  });

  it('jq allowlist 射影を挟んでも落ちる（jq 形状の妥当性は検証しない設計）', () => {
    expect(
      runGuard(
        bash(
          'curl -s "https://api.supabase.com/v1/projects/ref/config/auth" | jq \'{security_captcha_enabled}\'',
        ),
      ),
    ).toBe('block');
  });

  it('08-11 incident 2 の実行形（branches/{id} への直接アクセス）は落ちる', () => {
    expect(
      runGuard(bash('curl -s "https://api.supabase.com/v1/branches/efqkuihquhzhuhnwvffk"')),
    ).toBe('block');
  });

  it('projects/{ref}/branches（一覧形）も落ちる', () => {
    expect(runGuard(bash('curl -s "https://api.supabase.com/v1/projects/ref/branches"'))).toBe(
      'block',
    );
  });

  it('config / branches 以外の endpoint（例: actions）は落とさない', () => {
    expect(runGuard(bash('curl -s "https://api.supabase.com/v1/projects/ref/actions"'))).toBe(
      'allow',
    );
  });

  it('無関係な host への curl は落とさない', () => {
    expect(runGuard(bash('curl -s "https://example.com/foo"'))).toBe('allow');
  });

  // push前反証レビューで発見: invoke 判定を「コマンド先頭・shell separator直後」
  // に限定していたため、`--` の後ろに空白1つで置かれる形が anchor に一致せず
  // 素通りした。本ファイルの env-file 判定が既に採用している「コマンド名では
  // なく引数で判定する（位置に依存しない）」原則に揃え、空白境界のみを要求する
  // 形へ修正した。この test はその修正の回帰防止。
  it('op run -- の後ろに空白1つで置かれた curl も落ちる（anchor 限定の抜け穴修正）', () => {
    expect(
      runGuard(
        bash(
          'op run -- curl -s "https://api.supabase.com/v1/projects/ref/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"',
        ),
      ),
    ).toBe('block');
  });

  // merge前クロスレビュー（risk-reviewer / behavior-verifier）で発見: curl|wget
  // への invoke 限定は、node fetch / python urllib のような別 HTTP client で
  // 丸ごと迂回できた。この repo は scripts/*.mjs を書くのが日常 idiom で、
  // agent が同型 one-liner を書く動機は自然にある（安全な代替経路自体が
  // Node wrapper のため）。08-11 の denylist keyword 漏れと同じ「点を塞ぐ」
  // 形だった。curl|wget 限定を外し、endpoint 文字列（host + path）の言及
  // だけで無条件 block する設計へ変更した。
  it('curl|wget 以外の HTTP client（node fetch）でも落ちる（invoke 限定を外した修正の回帰防止）', () => {
    expect(
      runGuard(
        bash(
          "node -e \"fetch('https://api.supabase.com/v1/projects/ref/config/auth',{headers:{Authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}}).then(r=>r.json()).then(console.log)\"",
        ),
      ),
    ).toBe('block');
  });

  it('python3 urllib でも落ちる', () => {
    expect(
      runGuard(
        bash(
          'python3 -c "import urllib.request; urllib.request.urlopen(\'https://api.supabase.com/v1/branches/x\')"',
        ),
      ),
    ).toBe('block');
  });

  it('httpie（http コマンド）でも落ちる', () => {
    expect(runGuard(bash('http GET https://api.supabase.com/v1/projects/ref/config/auth'))).toBe(
      'block',
    );
  });

  // merge前クロスレビューで発見: 絶対パス起動（/usr/bin/curl 等）は invoke 判定の
  // 境界集合に `/` が無く素通りしていた。curl|wget 限定を外した上記修正により、
  // curl 自体はもはや invoke 判定を経由しない（endpoint 文字列だけで block する）
  // ため、この class は自動的に閉じている。回帰防止として残す。
  it('絶対パス起動の curl も落ちる（invoke 限定撤廃により自動的に閉じる）', () => {
    expect(
      runGuard(bash('/usr/bin/curl -s https://api.supabase.com/v1/projects/ref/config/auth')),
    ).toBe('block');
  });
});

describe('pre-tool-guard.mjs: #2293 vercel invoke anchor の抜け穴修正（push前反証レビュー・merge前クロスレビュー）', () => {
  it('op run -- の後ろに空白1つで置かれた vercel --token も落ちる', () => {
    expect(runGuard(bash('op run -- vercel ls --token abc123'))).toBe('block');
  });

  // merge前クロスレビューで発見: 絶対パス起動（/opt/homebrew/bin/vercel 等）は
  // 直前の文字が `/` で境界集合 [[:space:];&|] のどれにも一致せず素通りした。
  // 境界集合に `/` を追加して修正した。
  it('絶対パス起動（/opt/homebrew/bin/vercel）でも --token は落ちる', () => {
    expect(runGuard(bash('/opt/homebrew/bin/vercel ls --token abc123'))).toBe('block');
  });
});

describe('pre-tool-guard.mjs: #2293 op read（--reveal 相当の masking を持たず、例外なく block）', () => {
  it('redirect なしの op read は落ちる', () => {
    expect(runGuard(bash('op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY"'))).toBe('block');
  });

  it('後続コマンドと ; で連結しても落ちる', () => {
    expect(
      runGuard(bash('op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY" && echo done')),
    ).toBe('block');
  });

  // 当初は `>/dev/null` への破棄 redirect があれば通す設計だったが、push前
  // 反証レビューで2つの穴が見つかった: ① `2>/dev/null`（stderr破棄）が文字列
  // として `>/dev/null` を含むため誤って許可側に倒れ、stdout の実値はそのまま
  // 出力される ② 複数出現する場合、コマンド全体に1回でも `/dev/null` があれば
  // 全体を許可してしまい、redirect の無い方が漏れる。例外を作らず無条件で
  // block する設計へ変更した（接続確認は (a) の既定 masked 出力で代替できる）。
  it('stdout への破棄 redirect（>/dev/null）があっても、例外なく落ちる（設計変更）', () => {
    expect(
      runGuard(
        bash('op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY" >/dev/null && echo OK'),
      ),
    ).toBe('block');
  });

  it('stderr のみの破棄（2>/dev/null）は stdout の実値を隠さない（旧設計の穴の回帰防止）', () => {
    expect(
      runGuard(bash('op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY" 2>/dev/null')),
    ).toBe('block');
  });

  it('複数の op read が混在し、片方だけ redirect されていても両方落ちる（旧設計の穴の回帰防止）', () => {
    expect(
      runGuard(
        bash('op read "op://human/supabase/A" && op read "op://human/supabase/B" >/dev/null'),
      ),
    ).toBe('block');
  });

  it('op run -- の後ろに空白1つで置かれた op read も落ちる（anchor 限定の抜け穴修正）', () => {
    expect(
      runGuard(bash('op run -- op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY"')),
    ).toBe('block');
  });

  // merge前クロスレビューで発見: 絶対パス起動（/usr/local/bin/op 等）は直前の
  // 文字が `/` で境界集合 [[:space:];&|] のどれにも一致せず素通りした。
  // 境界集合に `/` を追加して修正した。
  it('絶対パス起動（/usr/local/bin/op read）でも落ちる', () => {
    expect(
      runGuard(bash('/usr/local/bin/op read "op://human/supabase/SUPABASE_SERVICE_ROLE_KEY"')),
    ).toBe('block');
  });

  it('代替経路（op item get --fields、既定形式）は影響を受けない', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: migrations 配下の既存ファイル編集（#2510、.sql 限定）', () => {
  // migrations 配下ガードは「適用済み migration の書き換え」を防ぐもの。
  // 判定が prefix 一致だけだと、配下のポインタ用 markdown（CLAUDE.md）まで
  // 編集不能＋的外れなエラー案内になるため、対象を .sql に限定した。
  const existingSql = resolve(rootDir, 'supabase/migrations/00000000000000_baseline.sql');
  const pointerMd = resolve(rootDir, 'supabase/migrations/CLAUDE.md');

  it('既存 .sql への Edit は引き続き block する', () => {
    expect(runGuard(edit(existingSql, 'DROP TABLE x;'))).toBe('block');
  });

  it('既存 .sql への Write も引き続き block する', () => {
    expect(runGuard(write(existingSql, 'DROP TABLE x;'))).toBe('block');
  });

  it('配下の非 SQL（CLAUDE.md、既存）への Edit は allow する', () => {
    expect(runGuard(edit(pointerMd, 'ポインタ更新'))).toBe('allow');
  });

  it('新規 .sql の作成（未存在ファイルへの Write）は引き続き allow する', () => {
    expect(
      runGuard(write(resolve(rootDir, 'supabase/migrations/99999999999999_new.sql'), 'SELECT 1;')),
    ).toBe('allow');
  });
});

// migration ガードの「適用済み」判定を、ディスク上の存在から **origin/main の tree に
// 在るか** へ寄せた（#2185）。main へ merge された migration は production へ適用される
// ので改変を止める必要があるが、未 merge の PR ブランチにしか無い migration は
// どの共有環境にも適用されておらず、同じ PR 内で直すのは正当な操作だった。
//
// 敵対的に見た時の懸念は「判定不能を allow へ倒して guard を無力化されること」なので、
// origin/main が無い / git が動かない / path を repo 相対へ直せない、を個別に block 側で
// 固定する。**allow のケースだけでなく、これら fail-closed のケースを必ず対で置く**。
describe('pre-tool-guard.mjs: migration の適用済み判定は origin/main 基準（#2185）', () => {
  let fixtureRoot: string;
  let repoDir: string;
  let appliedSql: string;
  let localOnlySql: string;
  let uncommittedSql: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-migration-origin-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );
    git(['init', '-q', '--bare', join(fixtureRoot, 'remote.git')], fixtureRoot);
    git(['remote', 'add', 'origin', join(fixtureRoot, 'remote.git')], repoDir);

    mkdirSync(join(repoDir, 'supabase', 'migrations'), { recursive: true });

    // (1) origin/main に載っている = 適用済み
    appliedSql = join(repoDir, 'supabase', 'migrations', '20260101000000_applied.sql');
    writeFileSync(appliedSql, 'select 1;\n');
    commitAndPush(repoDir, 'supabase/migrations/20260101000000_applied.sql');

    // (2) ローカル commit のみ（未 push）
    localOnlySql = join(repoDir, 'supabase', 'migrations', '20260202000000_local.sql');
    writeFileSync(localOnlySql, 'select 2;\n');
    commitOnly(repoDir, 'supabase/migrations/20260202000000_local.sql');

    // (3) 未 commit
    uncommittedSql = join(repoDir, 'supabase', 'migrations', '20260303000000_wip.sql');
    writeFileSync(uncommittedSql, 'select 3;\n');

    // 未 push の migration を指す symlink（正規化後の path で判定していることの確認）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(uncommittedSql, join(repoDir, 'tmp', 'wip-alias'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('origin/main に載っている migration の Edit は block する', () => {
    expect(runGuard(edit(appliedSql, 'DROP TABLE x;'), repoDir)).toBe('block');
  });

  it('origin/main に載っている migration の Write も block する', () => {
    expect(runGuard(write(appliedSql, 'DROP TABLE x;'), repoDir)).toBe('block');
  });

  it('ローカル commit のみ（未 push）の migration は allow する', () => {
    expect(runGuard(edit(localOnlySql, 'ALTER TABLE x;'), repoDir)).toBe('allow');
  });

  it('未 commit の migration は allow する', () => {
    expect(runGuard(edit(uncommittedSql, 'ALTER TABLE x;'), repoDir)).toBe('allow');
  });

  it('未 push の migration を指す symlink も allow する（正規化後の path で判定している）', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'wip-alias'), 'select 9;'), repoDir)).toBe('allow');
  });

  it('origin/main の ref が無い repo では block する（fail-closed）', () => {
    const noOriginRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-migration-no-origin-'));
    try {
      git(['init', '-q', '.'], noOriginRoot);
      git(
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        noOriginRoot,
      );
      mkdirSync(join(noOriginRoot, 'supabase', 'migrations'), { recursive: true });
      const sql = join(noOriginRoot, 'supabase', 'migrations', '20260101000000_x.sql');
      writeFileSync(sql, 'select 1;\n');
      expect(runGuard(edit(sql, 'DROP TABLE x;'), noOriginRoot)).toBe('block');
    } finally {
      rmSync(noOriginRoot, { recursive: true, force: true });
    }
  });

  it('git が使えない（PATH に git が無い）環境では block する（fail-closed）', () => {
    // guard は git を PATH から引く。git が引けない時に allow へ倒れると、
    // PATH を細工するだけで適用済み migration を書き換えられてしまう。
    expect(runGuard(edit(appliedSql, 'DROP TABLE x;'), repoDir, { PATH: '/nonexistent' })).toBe(
      'block',
    );
  });
});

// R1/R2: Agent の model 明示 + 探索への opus/fable 使用ガード（cost guard）。
// security guard ではないため、jq parse エラー等は fail-open にする設計だが、
// 通常の JSON 入力ではその分岐は踏まない。ここでは正規の判定ロジックを固定する。
describe('pre-tool-guard.mjs: model choice does not grant or remove permissions', () => {
  it.each(['', 'sonnet', 'opus', 'gpt-6-astra', 'gemini'])(
    'allows delegation with model %s',
    (model) => {
      expect(runGuard(agentCall({ model, prompt: '調査' }))).toBe('allow');
    },
  );
});

describe('pre-tool-guard.mjs: R3 Read の範囲指定なし大規模ファイル読み込み', () => {
  let fixtureRoot: string;
  let bigFile: string;
  let smallFile: string;
  let pngFile: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-read-'));
    bigFile = join(fixtureRoot, 'big.ts');
    smallFile = join(fixtureRoot, 'small.ts');
    pngFile = join(fixtureRoot, 'image.png');
    writeFileSync(bigFile, Array.from({ length: 700 }, (_, i) => `// line ${i}`).join('\n'));
    writeFileSync(smallFile, Array.from({ length: 50 }, (_, i) => `// line ${i}`).join('\n'));
    writeFileSync(pngFile, 'not a real png, contents irrelevant');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('700 行のファイルを offset/limit なしで Read しようとすると block する', () => {
    expect(runGuard(readTool(bigFile))).toBe('block');
  });

  it('limit を付ければ通す', () => {
    expect(runGuard(readTool(bigFile, { limit: 100 }))).toBe('allow');
  });

  it('offset を付ければ通す', () => {
    expect(runGuard(readTool(bigFile, { offset: 500 }))).toBe('allow');
  });

  it('50 行のファイルは範囲指定なしでも通す', () => {
    expect(runGuard(readTool(smallFile))).toBe('allow');
  });

  it('.png のような非テキスト拡張子は行数に関わらず通す', () => {
    expect(runGuard(readTool(pngFile))).toBe('allow');
  });

  it('存在しないパスは通す（fail-open）', () => {
    expect(runGuard(readTool(join(fixtureRoot, 'does-not-exist.ts')))).toBe('allow');
  });
});

// JS の \s は U+00A0（NBSP）等の Unicode 空白も区切りとして受理するが、bash の IFS は
// ASCII 空白だけを単語区切りにする。許可名の直後に NBSP を置いた別ファイル名は shell では
// 1 語のまま渡り、guard が「許可名 + 区切り」と誤認すると別ファイルが消費される
// （Codex review P2、PR #2563。旧 bash 版の [[:space:]] は NBSP を含まなかった）。
describe('pre-tool-guard.mjs: env-file 名の直後の非 ASCII 空白（NBSP）', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pre-tool-guard-nbsp-'));
    writeFileSync(join(dir, '.op-env.agent'), 'A=op://agent/x/y\n');
    writeFileSync(join(dir, '.op-env.agent\u00a0x'), 'B=op://human/x/y\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('許可名 + NBSP + 別名 を許可形と誤認せず block する', () => {
    expect(runGuard(bash('op run --env-file=.op-env.agent\u00a0x -- pnpm typecheck'), dir)).toBe(
      'block',
    );
  });

  it('許可名だけの通常形は引き続き通る', () => {
    expect(runGuard(bash('op run --env-file=.op-env.agent -- pnpm typecheck'), dir)).toBe('allow');
  });
});

// =====================================================================
// gh pr merge / gh api ...pulls/.../merge の直接実行（cost guard、#2596）
// =====================================================================
// merge 経路を `pnpm branch:finish <N>` 1 本に機械的に絞る。free plan の private
// repo では branch protection / ruleset が使えず、CI red の遮断は
// finish-branch.sh の statusCheckRollup 判定だけが担っている。
//
// 他の Bash guard と同じく、**文字列に言及しただけでも落ちる**（コマンド本文を
// 走査するため）。docs や commit message へ書く時は Write / Edit で file に
// 書いてから渡す。
describe('pre-tool-guard.mjs: gh pr merge 直接実行（#2596）', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

  it('gh pr merge を直接実行すると block する', () => {
    expect(runGuard(bash('gh pr merge 2596'))).toBe('block');
  });

  it('gh pr merge に追加フラグが付いていても block する', () => {
    expect(runGuard(bash('gh pr merge 2596 --merge --delete-branch'))).toBe('block');
  });

  it('引用符付きの PR 番号でも block する', () => {
    expect(runGuard(bash('gh pr merge "2596"'))).toBe('block');
  });

  it('gh api で pulls/<N>/merge へ -X PUT する直接実行を block する', () => {
    expect(
      runGuard(
        bash(
          'gh api -X PUT repos/Dayopt/dayopt/pulls/2596/merge -f merge_method=merge -f sha=abc123',
        ),
      ),
    ).toBe('block');
  });

  it('--method PUT（フラグの別表記）でも block する', () => {
    expect(
      runGuard(
        bash('gh api --method PUT repos/Dayopt/dayopt/pulls/2596/merge -f merge_method=merge'),
      ),
    ).toBe('block');
  });

  it('--method put（小文字）でも block する', () => {
    expect(
      runGuard(
        bash('gh api --method put repos/Dayopt/dayopt/pulls/2596/merge -f merge_method=merge'),
      ),
    ).toBe('block');
  });

  it('pnpm branch:finish は通す（誘導先を塞がない）', () => {
    expect(runGuard(bash('pnpm branch:finish 2596'))).toBe('allow');
  });

  it('bash scripts/tasks/finish-branch.sh の直接起動も通す', () => {
    expect(runGuard(bash('bash scripts/tasks/finish-branch.sh 2596'))).toBe('allow');
  });

  it('gh pr view 等 merge 以外の pr 操作は通す', () => {
    expect(runGuard(bash('gh pr view 2596'))).toBe('allow');
  });

  it('PUT を伴わない gh api での pulls/.../merge 参照（状態確認）は通す', () => {
    expect(runGuard(bash('gh api repos/Dayopt/dayopt/pulls/2596/merge'))).toBe('allow');
  });

  it('merge を含まない別コマンド名（word boundary）は通す', () => {
    expect(runGuard(bash('gh pr merger-status 2596'))).toBe('allow');
  });
});

// PreToolUse hook の launcher（2026-09-05, #2565）。
//
// Claude Code は PreToolUse hook の **exit 2 だけ**を block と解釈し、それ以外の
// 非 0（not found = 127 を含む）は non-blocking error として tool 実行を続行する。
// settings.json に `node scripts/hooks/pre-tool-guard.mjs` と書いていた頃は hook の
// 起動が `node` の PATH 解決に依存し、解決できない実行コンテキストでは 8 matcher が
// すべて無言で fail-open していた（実測: 旧 command は node 不在 PATH で exit 127）。
//
// launcher は shell 経由でも argv 直渡しでも動く必要がある（harness の実行
// セマンティクスは repo 側から固定できない）。両方の起動形をここで固定する。
describe('pre-tool-guard.sh: launcher の fail-closed（#2565）', () => {
  const launcherPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard.sh');
  // POSIX 既定に近い、この repo の node（非標準ロケーション）を含まない PATH。
  const PATH_WITHOUT_NODE = '/usr/bin:/bin';

  function runLauncher(
    input: Record<string, unknown>,
    opts: { viaShell: boolean; path?: string },
  ): { status: number | null; stderr: string } {
    const env = { PATH: opts.path ?? (process.env.PATH as string) };
    const result = opts.viaShell
      ? // settings.json の command 文字列が sh -c 経由で実行される場合
        spawnSync('sh', ['-c', 'scripts/hooks/pre-tool-guard.sh'], {
          cwd: rootDir,
          encoding: 'utf8',
          input: JSON.stringify(input),
          env,
        })
      : // argv 直渡しで実行される場合（shebang + 実行ビットで起動する）
        spawnSync(launcherPath, [], {
          cwd: rootDir,
          encoding: 'utf8',
          input: JSON.stringify(input),
          env,
        });
    return { status: result.status, stderr: result.stderr ?? '' };
  }

  it('launcher は実行ビットを持つ（argv 直渡しでも起動できる）', () => {
    // eslint-disable-next-line no-bitwise -- 実行ビットの検査は mode のビット演算でしか書けない
    expect(statSync(launcherPath).mode & 0o111).not.toBe(0);
  });

  it.each([
    ['shell 経由', true],
    ['argv 直渡し', false],
  ])('node が PATH に無い時は block する（exit 2、fail closed）: %s', (_label, viaShell) => {
    const { status, stderr } = runLauncher(write('/home/user/x/notes.md'), {
      viaShell: viaShell as boolean,
      path: PATH_WITHOUT_NODE,
    });

    // 127（not found）だと Claude Code は tool 実行を続行してしまう。2 でなければならない。
    expect(status).toBe(2);
    expect(stderr).toContain('node を解決できないため');
  });

  it.each([
    ['shell 経由', true],
    ['argv 直渡し', false],
  ])('通常の PATH では従来どおり判定を委譲する: %s', (_label, viaShell) => {
    const opts = { viaShell: viaShell as boolean };

    expect(runLauncher(write(join(rootDir, '.env')), opts).status).toBe(2);
    expect(runLauncher(bash('git status'), opts).status).toBe(0);
  });

  it('settings.json の 8 matcher すべてが launcher を指している', () => {
    // node を直接指す形へ戻すと fail-open が復活する。8 箇所とも launcher であること
    // を固定する（1 箇所だけ戻す差分をレビューで見落とさないため）。
    const settings = JSON.parse(readFileSync(resolve(rootDir, '.claude/settings.json'), 'utf8'));
    const commands = settings.hooks.PreToolUse.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((hook) => hook.command),
    );

    expect(commands).toHaveLength(8);
    expect(new Set(commands)).toEqual(new Set(['scripts/hooks/pre-tool-guard.sh']));
  });
});
