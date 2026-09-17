// Codex wire format adapter. Policy remains in pre-tool-guard-rules.mjs.
// No tool input or exception details are logged: they can contain secret values.
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function deny(message) {
  return { decision: 'block', message: `BLOCKED: ${message}` };
}

// Codex の native delegation は read-only sandbox / repository scope 制限を tool input から証明できない。
// scope を runtime で強制できる adapter がない間は、読み取りも親担当が行う。
const NATIVE_DELEGATION_TOOLS = new Set(['spawn_agent', 'collaboration.spawn_agent']);

/** Extract every touched path, including both sides of a rename, before evaluating any. */
export function parsePatch(command) {
  if (typeof command !== 'string') throw new Error('patch is missing');
  const lines = command.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('invalid patch envelope');
  }
  const operations = [];
  let operation;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      operation = { kind: header[1], path: header[2], move: null, added: [] };
      operations.push(operation);
    } else if (line.startsWith('*** Move to: ')) {
      if (!operation || operation.kind !== 'Update' || operation.move !== null) {
        throw new Error('invalid move');
      }
      operation.move = line.slice('*** Move to: '.length);
    } else if (line.startsWith('+')) {
      if (!operation || operation.kind === 'Delete') throw new Error('unexpected content');
      operation.added.push(line.slice(1));
    } else if (
      operation?.kind === 'Update' &&
      (line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('@@') ||
        line === '*** End of File')
    ) {
      // Context / deleted text is not new file content.
    } else {
      throw new Error('unsupported patch line');
    }
  }
  if (operations.length === 0) throw new Error('empty patch');
  return operations;
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolve existing ancestors and dangling links without opening file contents.
function physicalTarget(target, depth = 0) {
  if (depth > 32) throw new Error('symlink cycle');
  try {
    return realpathSync(target);
  } catch {
    /* A new file may not exist yet. */
  }
  let link;
  try {
    if (lstatSync(target).isSymbolicLink()) link = readlinkSync(target);
  } catch {
    /* Resolve the parent of a missing file. */
  }
  if (link !== undefined) return physicalTarget(resolve(dirname(target), link), depth + 1);
  const parent = dirname(target);
  if (parent === target) return target;
  return resolve(physicalTarget(parent, depth + 1), basename(target));
}

export async function evaluateCodex(rawInput, options = {}) {
  const payload = JSON.parse(rawInput);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return deny('hook input が不正です');
  const { tool_name: tool, tool_input: input } = payload;
  if (typeof tool !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
    return deny('tool input が不正です');
  }
  const shellCwd =
    tool === 'Bash' || tool === 'exec_command' ? (input.workdir ?? input.cwd) : undefined;
  const suppliedCwd = shellCwd ?? payload.cwd ?? options.cwd ?? process.cwd();
  if (typeof suppliedCwd !== 'string' || !isAbsolute(suppliedCwd))
    return deny('cwd を確認できません');
  const cwd = realpathSync(suppliedCwd);
  if (NATIVE_DELEGATION_TOOLS.has(tool))
    return deny(
      'native delegation は read-only と repository scope の実行境界を証明できないため禁止です（親担当が調査してください）',
    );
  const { evaluate } = await import('./pre-tool-guard-rules.mjs');
  const check = (name, args) =>
    evaluate(JSON.stringify({ tool_name: name, tool_input: args }), { cwd });
  if (tool === 'Bash' || tool === 'exec_command') {
    const command = input.command ?? input.cmd;
    if (typeof command !== 'string' || !command.trim())
      return deny('shell command を確認できません');
    // Literal secret-file access is a guardrail, not a shell interpreter or a filesystem sandbox.
    const unquoted = command.replace(/["'\\]/g, '');
    if (
      /(^|[\s/;|&=<>])\.env(?:[.*][^\s;|&<>]*)?(?=$|[\s/;|&<>])|(^|[\s/;|&=<>])\.envrc(?=$|[\s;|&<>])/.test(
        unquoted,
      )
    ) {
      return deny('実値を含みうる env ファイルへの shell アクセスは禁止です');
    }
    return check('Bash', { command });
  }
  if (tool === 'apply_patch') {
    const operations = parsePatch(input.command ?? input.patch);
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    for (const operation of operations) {
      for (const name of [operation.path, operation.move].filter(Boolean)) {
        const path = resolve(cwd, name);
        if (!within(root, path) || !within(physicalTarget(root), physicalTarget(path)))
          return deny('patch の対象が現在の worktree 外です');
        const result = check('Write', { file_path: path, content: operation.added.join('\n') });
        if (result.decision !== 'allow') return result;
      }
      // A rename can carry old vault references without any added lines. Require an explicit write.
      if (
        operation.move &&
        [resolve(cwd, operation.move), physicalTarget(resolve(cwd, operation.move))].some(
          (target) => /\.op-env\.(agent|local)(\.example)?$/.test(target),
        )
      ) {
        return deny('agent 用 env 参照への rename は使わず、内容を明示して作成してください');
      }
    }
    return { decision: 'allow' };
  }
  return check(tool, input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const result = await evaluateCodex(input);
    if (result.decision !== 'allow') {
      // Do not echo the shared guard's command-bearing errors into session logs.
      writeSync(
        2,
        'BLOCKED: Dayopt の操作ポリシーに違反しています。対象と操作を確認してください。\n',
      );
      process.exitCode = 2;
    }
  } catch {
    writeSync(2, 'BLOCKED: Codex guard が入力を検証できませんでした（fail closed）。\n');
    process.exitCode = 2;
  }
}
