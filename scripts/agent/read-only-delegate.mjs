#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SCOPE_COUNT = 40;
const MAX_SCOPE_LENGTH = 240;
const MAX_TASK_LENGTH = 4000;
const PROVIDERS = new Set(['codex', 'claude']);
const SAFE_ENV_KEYS = new Set([
  'CI',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TMP',
  'TEMP',
  'TMPDIR',
  'USER',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);

const SECRET_PATH_SEGMENT =
  /^(?:\.env.*$|\.op-env(?:\.|$)|\.git(?:$|[\\/])|\.ssh(?:$|[\\/])|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|kdbx)$/i;
const SECRET_VALUE =
  /(?:op:\/\/|(?:ghp|gho|github_pat|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}))/i;

function fail(message) {
  throw new Error(message);
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function repoRoot(cwd) {
  try {
    return realpathSync(
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    fail('Git worktree を確認できません');
  }
}

function currentHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function sensitivePath(path) {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return (
    segments.some((segment) => SECRET_PATH_SEGMENT.test(segment)) || SECRET_EXTENSION.test(path)
  );
}

/**
 * Validate and canonicalize repository-relative scope paths. Existing symlinks must resolve
 * inside the worktree; missing paths are rejected so a caller cannot smuggle an extra directory
 * into a child runtime through a later-created symlink.
 */
export function validateScope(scopes, root) {
  if (!Array.isArray(scopes) || scopes.length === 0)
    fail('少なくとも 1 つの scope を指定してください');
  if (scopes.length > MAX_SCOPE_COUNT) fail(`scope は ${MAX_SCOPE_COUNT} 件までです`);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    fail('Git worktree の実体を確認できません');
  }
  const canonical = [];
  for (const raw of scopes) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SCOPE_LENGTH) {
      fail('scope は空でなく、短い repo 相対 path で指定してください');
    }
    if (raw.includes('\0') || raw.includes('\\') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw))
      fail('scope は repo 相対 path で指定してください');
    const normalized = raw.replace(/\/+/g, '/');
    if (normalized === '.' || normalized.split('/').some((segment) => segment === '..'))
      fail('scope が worktree の外を指しています');
    if (sensitivePath(normalized)) fail('secret を含みうる path は scope にできません');
    const target = resolve(canonicalRoot, normalized);
    if (!within(canonicalRoot, target) || !existsSync(target))
      fail('scope が worktree 内の既存 path ではありません');
    let physical;
    try {
      physical = realpathSync(target);
    } catch {
      fail('scope の実体を確認できません');
    }
    if (!within(canonicalRoot, physical) || sensitivePath(relative(canonicalRoot, physical)))
      fail('scope の symlink が worktree 外または secret path を指しています');
    canonical.push(normalized);
  }
  return [...new Set(canonical)];
}

export function validateTask(task) {
  if (typeof task !== 'string' || task.trim().length === 0 || task.length > MAX_TASK_LENGTH)
    fail(`task は 1〜${MAX_TASK_LENGTH} 文字で指定してください`);
  if (task.includes('\0') || SECRET_VALUE.test(task))
    fail('task に credential らしき値を含めないでください');
  return task.trim();
}

/** Remove environment values that could carry credentials or alter the child policy. */
export function buildChildEnv(env = process.env) {
  return Object.fromEntries(
    [...SAFE_ENV_KEYS]
      .filter((key) => typeof env[key] === 'string')
      .map((key) => [key, env[key]])
      .filter(([, value]) => !SECRET_VALUE.test(value)),
  );
}

export function buildPrompt({ root, head, scopes, task }) {
  return [
    'You are a bounded repository investigator.',
    'This is a read-only delegation. Inspect files only.',
    'Do not modify the repository.',
    `Repository root: ${root}`,
    `Current HEAD: ${head}`,
    `Allowed scope (and no other repository paths): ${scopes.join(', ')}`,
    '',
    'Do not run tests, builds, installs, scripts with side effects, network calls, MCP tools, nested agents, git mutations, commits, pushes, or external state changes.',
    'Do not read or print credentials, environment files, vault references, private keys, or unrelated paths.',
    'Return a concise report with exactly these sections:',
    'Scope checked:',
    'Facts (with file and symbol or line locations):',
    'Unknowns / not checked:',
    'Suggested follow-up for the parent (if any):',
    '',
    `Investigation task: ${task}`,
  ].join('\n');
}

export function buildInvocation({ provider, root, head, scopes, task }) {
  if (!PROVIDERS.has(provider)) fail('provider は codex または claude を指定してください');
  const prompt = buildPrompt({ root, head, scopes, task });
  if (provider === 'codex') {
    return {
      command: 'codex',
      args: [
        '--ask-for-approval',
        'untrusted',
        'exec',
        '--model',
        'gpt-5.6-luna',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--cd',
        root,
        '--color',
        'never',
        prompt,
      ],
      prompt,
    };
  }
  return {
    command: 'claude',
    args: [
      '-p',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--permission-mode',
      'plan',
      '--tools',
      'Read,Glob,Grep',
      '--no-session-persistence',
      prompt,
    ],
    prompt,
  };
}

function redactOutput(value) {
  return String(value ?? '')
    .replace(/op:\/\/[^\s`"']+/gi, 'op://[redacted]')
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]+\b/gi, '[redacted-github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[redacted-api-key]')
    .replace(/\b(?:xox[baprs])-[A-Za-z0-9-]{8,}\b/gi, '[redacted-token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]');
}

/**
 * @param {{ provider: string, scopes: string[], task: string, cwd?: string, timeoutMs?: number,
 *   spawnImpl?: typeof spawnSync }} options
 */
export function runReadOnlyDelegate({
  provider,
  scopes,
  task,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawnSync,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS)
    fail(`timeout は 1〜${DEFAULT_TIMEOUT_MS} ms で指定してください`);
  const root = repoRoot(cwd);
  const safeScopes = validateScope(scopes, root);
  const safeTask = validateTask(task);
  const invocation = buildInvocation({
    provider,
    root,
    head: currentHead(root),
    scopes: safeScopes,
    task: safeTask,
  });
  const result = spawnImpl(invocation.command, invocation.args, {
    cwd: root,
    env: buildChildEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
  });
  return {
    ...result,
    command: invocation.command,
    args: invocation.args,
    stdout: redactOutput(result?.stdout),
    stderr: redactOutput(result?.stderr),
  };
}

function usage() {
  console.error(
    'Usage: pnpm agent:readonly --provider <codex|claude> --scope <repo-relative-path> [--scope <path> ...] --task <read-only task>',
  );
}

function parseArgs(args) {
  let provider;
  let task;
  const scopes = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--provider' || arg === '--scope' || arg === '--task') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} の値がありません`);
      index += 1;
      if (arg === '--provider') provider = value;
      else if (arg === '--scope') scopes.push(value);
      else task = value;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      return null;
    } else {
      fail('未知の引数です');
    }
  }
  if (!provider || !task || scopes.length === 0) fail('provider、scope、task はすべて必須です');
  return { provider, scopes, task };
}

export { DEFAULT_TIMEOUT_MS, MAX_SCOPE_COUNT, MAX_SCOPE_LENGTH, MAX_TASK_LENGTH, parseArgs };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === null) process.exitCode = 0;
    else {
      const result = runReadOnlyDelegate(parsed);
      if (result.stdout)
        process.stdout.write(`${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}`);
      if (result.stderr)
        process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
      if (result.error || result.status !== 0) {
        console.error(
          'read-only delegate が完了しませんでした。親担当が同じ scope を確認してください。',
        );
        process.exitCode = result.error?.code === 'ETIMEDOUT' ? 124 : (result.status ?? 1);
      }
    }
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : 'read-only delegate failed');
    process.exitCode = 1;
  }
}
