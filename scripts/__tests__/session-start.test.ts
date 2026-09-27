import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/hooks/session-start.sh` の contract test。
 *
 * この hook は cloud session（CLAUDE_CODE_REMOTE=true）で依存 install を担い、
 * pre-commit / pre-push の検証層（husky の `prepare` が core.hooksPath を設定する）を
 * session 開始時点で有効にする。fresh clone の container では install まで hook が
 * 一切効かないため、ここが抜けると cloud からの push は検証なしで通る。
 *
 * 敵対的に見るべき点は 2 つ:
 *   - ローカル（remote でない）で勝手に install が走らないこと（User の依存管理を奪わない）
 *   - install が失敗しても hook が非 0 で落ちず、失敗を context へ残すこと
 *     （session 開始を止めるより、agent に「手動で install してから commit」と伝える方が安全）
 *
 * pnpm は stub に差し替える（実 install は走らせない）。stub は受け取った引数を
 * STUB_RECORD へ1呼び出し1行で書き、STUB_EXIT で終了コードを制御する。
 */
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hookPath = resolve(rootDir, 'scripts/hooks/session-start.sh');

function run(args: string[], cwd: string): void {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

/** 実バイナリの絶対 path。無ければ null（timeout は macOS に無い）。 */
function realBinPath(name: string): string | null {
  const result = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

function requireRealBinPath(name: string): string {
  const found = realBinPath(name);
  if (!found) throw new Error(`${name} が PATH に見つかりません（test 前提）`);
  return found;
}

let workDir: string;
let repoDir: string;
let stubDir: string;
let ghStubDir: string;
let basePath: string;
let bashPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'session-start-'));
  repoDir = join(workDir, 'repo');
  mkdirSync(repoDir);
  run(['git', 'init', '-q'], repoDir);
  run(['git', 'config', 'user.email', 'test@example.com'], repoDir);
  run(['git', 'config', 'user.name', 'test'], repoDir);
  writeFileSync(join(repoDir, '.nvmrc'), '24\n');
  run(['git', 'add', '.nvmrc'], repoDir);
  run(['git', 'commit', '-q', '-m', 'init'], repoDir);

  stubDir = join(workDir, 'stub');
  mkdirSync(stubDir);
  const pnpmStub = join(stubDir, 'pnpm');
  writeFileSync(
    pnpmStub,
    '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$STUB_RECORD"\nexit "${STUB_EXIT:-0}"\n',
  );
  chmodSync(pnpmStub, 0o755);

  // gh の有無は PATH だけで切り替える（存在判定は command -v）。
  ghStubDir = join(workDir, 'gh-stub');
  mkdirSync(ghStubDir);
  const ghStub = join(ghStubDir, 'gh');
  writeFileSync(ghStub, '#!/bin/bash\nexit 0\n');
  chmodSync(ghStub, 0o755);

  // PATH をホスト環境から隔離する。/usr/bin を丸ごと通すと GitHub-hosted runner の
  // プリインストール gh が拾われ、`gh:no` を期待する case が CI で落ちる
  // （Codex review P2、PR #2563）。hook が使う実バイナリだけを symlink した
  // ディレクトリを作り、stub とそれ以外は一切見せない。
  const isolatedBin = join(workDir, 'bin');
  mkdirSync(isolatedBin);
  for (const name of ['git', 'date', 'wc', 'tr', 'cat', 'dirname', 'which']) {
    symlinkSync(requireRealBinPath(name), join(isolatedBin, name));
  }
  const timeoutPath = realBinPath('timeout');
  if (timeoutPath) symlinkSync(timeoutPath, join(isolatedBin, 'timeout'));
  symlinkSync(process.execPath, join(isolatedBin, 'node'));
  bashPath = requireRealBinPath('bash');
  basePath = `${stubDir}:${isolatedBin}`;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  record: string | null;
  tmp: string;
}

function runHook(opts: { remote: boolean; stubExit?: number; withGh?: boolean }): HookRun {
  const tmp = mkdtempSync(join(workDir, 'run-'));
  const record = join(tmp, 'pnpm-args');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: opts.withGh ? `${ghStubDir}:${basePath}` : basePath,
    TMPDIR: tmp,
    STUB_RECORD: record,
  };
  // この test 自体が cloud session で走ることがある（CLAUDE_CODE_REMOTE=true が
  // 継承される）。local の分岐を検証するには明示的に消す必要がある。
  delete env.CLAUDE_CODE_REMOTE;
  if (opts.remote) env.CLAUDE_CODE_REMOTE = 'true';
  if (opts.stubExit !== undefined) env.STUB_EXIT = String(opts.stubExit);

  // bash は隔離 PATH に無いので絶対 path で起動する。
  const result = spawnSync(bashPath, [hookPath], {
    cwd: repoDir,
    encoding: 'utf8',
    input: '{"source":"startup"}',
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    record: existsSync(record) ? readFileSync(record, 'utf8') : null,
    tmp,
  };
}

function recordedPnpmCalls(record: string | null): string[] {
  return record?.split('\n').filter(Boolean) ?? [];
}

describe('session-start.sh: 依存 install（cloud session だけ）', () => {
  it('remote でなければ install を呼ばず、deps の欠落だけを報告する', () => {
    const r = runHook({ remote: false });
    expect(r.status).toBe(0);
    expect(recordedPnpmCalls(r.record)).toContain('--version');
    expect(recordedPnpmCalls(r.record)).not.toContain('install --frozen-lockfile');
    expect(r.stdout).toContain('**remote**: no');
    expect(r.stdout).toContain('**deps**: missing (pnpm install --frozen-lockfile)');
  });

  it('remote なら pnpm install --frozen-lockfile を 1 回だけ呼び、所要秒を報告する', () => {
    const r = runHook({ remote: true });
    expect(r.status).toBe(0);
    expect(recordedPnpmCalls(r.record)).toContain('--version');
    expect(
      recordedPnpmCalls(r.record).filter((call) => call === 'install --frozen-lockfile'),
    ).toHaveLength(1);
    expect(r.stdout).toContain('**remote**: yes');
    expect(r.stdout).toMatch(/\*\*deps\*\*: installed \(\d+s\)/);
    expect(existsSync(join(r.tmp, 'dayopt-session-start-install.log'))).toBe(true);
  });

  it('install が失敗しても exit 0 のまま、失敗と手動手順を context に残す', () => {
    const r = runHook({ remote: true, stubExit: 1 });
    expect(r.status).toBe(0);
    expect(recordedPnpmCalls(r.record)).toContain('--version');
    expect(
      recordedPnpmCalls(r.record).filter((call) => call === 'install --frozen-lockfile'),
    ).toHaveLength(1);
    expect(r.stdout).toMatch(/\*\*deps\*\*: install failed \(exit 1, \d+s, log: /);
    expect(r.stdout).toContain('依存 install に失敗');
    expect(r.stdout).toContain('pnpm install --frozen-lockfile');
  });
});

describe('session-start.sh: 実行環境の報告', () => {
  it('Project State の後に Environment 節を出し、node / .nvmrc / CLI 有無を 1 行ずつ載せる', () => {
    const r = runHook({ remote: false });
    const stateIndex = r.stdout.indexOf('## Project State');
    const envIndex = r.stdout.indexOf('### Environment');
    expect(stateIndex).toBeGreaterThanOrEqual(0);
    expect(envIndex).toBeGreaterThan(stateIndex);
    expect(r.stdout).toMatch(/\*\*node\*\*: v\d+\.\d+\.\d+ \(\.nvmrc: 24\)/);
    expect(r.stdout).toMatch(/\*\*cli\*\*: gh:no codex:no op:no supabase:no gitleaks:no vercel:no/);
  });

  it('gh が無ければ、gh 依存の L0 入口（ctx / trace / branch:finish）が使えない旨と MCP への迂回を出す', () => {
    const r = runHook({ remote: false });
    expect(r.stdout).toContain('gh なし');
    expect(r.stdout).toContain('ctx');
    expect(r.stdout).toContain('branch:finish');
    expect(r.stdout).toContain('利用可能な接続');
  });

  it('gh があれば gh:yes になり、迂回の案内は出ない', () => {
    const r = runHook({ remote: false, withGh: true });
    expect(r.stdout).toContain('gh:yes');
    expect(r.stdout).not.toContain('gh なし');
  });
});
