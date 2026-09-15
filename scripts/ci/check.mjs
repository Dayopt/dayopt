#!/usr/bin/env node

/**
 * scripts/ci/check.mjs — `.github/workflows/ci.yml` の実行本体（#2483 Phase 1）。
 *
 * 「薄い呼び出し層（ci.yml） + scripts 側の実体」再編の実体側。ci.yml は
 * checkout・setup・Supabase CLI の起動可否（`if:`）・secrets の受け渡しだけを
 * 担い、affected 判定（docs-only skip・integration の DB-touch 判定）と
 * 各種チェックの実行はここに内包する。
 *
 * Usage:
 *   node scripts/ci/check.mjs impact
 *   node scripts/ci/check.mjs static
 *   node scripts/ci/check.mjs unit
 *   node scripts/ci/check.mjs integration
 *
 * impact:      PR の変更ファイルから affected 判定を出すだけの軽量 job（全 job の上流）
 * static:      gitleaks CLI + allowlist canary + secrets:check + docs:check +
 *              validate:content（常時）+ typecheck/lint/knip/check:static の並列
 *              lane（docs-only でなければ）+ supabase/functions/** 変更時のみ deno check
 * unit:        unit（product/web/i18n/observability + scripts、常時）+ 新規 migration の
 *              destructive scan（pull_request イベント時は常時）。**DB を一切使わない**
 * integration: affected な PR だけ integration/RLS（Supabase の起動自体は ci.yml 側の
 *              `if:` が担い、接続情報は env 経由で渡される前提）
 *
 * **unit と integration を別 job に分けてあるのは、直列だった 2 種類の検査を
 * 並列化するため**（2026-09-02、#2539）。分割前は 1 job の中で「Supabase 起動
 * （約 3 分）→ unit（約 7 分）→ integration（約 1.6 分）」が直列に並んでいた。
 * 分割後は unit と integration が別 runner で同時に走る（実測値の正本は
 * docs/engineering/infra.md §merge gate。ここには数値を置かない）。
 *
 * **CPU 競合はほぼ関係なかった**（当初の仮説は実測で否定された）。同じ
 * product unit test の所要は Supabase 同居時 5 分 06 秒 / 非同居時 4 分 55 秒で、
 * 差は 3.6% しかない。分割前のデータで「integration を走らせない PR は 1〜2 分」に
 * 見えたのは、それらが同時に `product_unit=false`（product unit test 自体を skip）
 * だったための交絡で、Supabase の有無とは無関係だった。
 *
 * したがって **product unit test の 5 分そのものは、この分割では縮んでいない**。
 * そこを縮めるのは別の手（affected 判定の見直し / vitest --changed 等、#2539 の続き）。
 *
 * impact 判定は impact モードで 1 回だけ行い、`$GITHUB_OUTPUT` へ書き出す
 * （docs_only / product_unit / integration / functions_changed）。static / unit /
 * integration job はそれを `needs.impact.outputs` 経由で env として受け取り、
 * ここでは再計算しない — 同一 PR の複数 job で gh api を叩いて結果がずれる
 * リスクを避けるため。判定を独立 job にしたのは、static の完走（実測 4 分 20 秒）を
 * 待たずに重い job を起動するため（詳細は runImpact のコメント）。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkFiles as detectDestructiveMigrations,
  evaluateCoupledMigration,
  formatCoupledSummary,
  formatSummary as formatMigrationSummary,
} from './check-destructive-migration.mjs';
import {
  formatGithubOutput,
  formatSummary as formatImpactSummary,
  resolveImpact,
} from './impact.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// DI 用の簡略型（`typeof execFileSync` 等の strict overload 型をそのまま JSDoc に
// 使うと、test の単純な mock（`vi.fn(() => 'stdout')` 等）が Node の完全な戻り値型
// （pid/output/stdout/stderr/signal を持つ SpawnSyncReturns 等）と一致せず
// typecheck が落ちる。scripts/lib/gh.mjs の ExecFileImpl と同じ設計判断——
// 実際に呼び出し側が使うプロパティだけを持つ最小型に絞る）。
/** @typedef {(file: string, args: string[], options?: object) => string} ExecFileImpl */
/** @typedef {(command: string, args: string[], options?: object) => { status: number | null }} SpawnImpl */
/** @typedef {(path: string, encoding: string) => string} ReadFileImpl */

// ─── PR ファイル一覧の取得 ────────────────────────────────────────────
// pull_request イベント以外（workflow_dispatch 等）は PR context が無いため
// 空配列を返す。呼び出し側（resolveImpact 等）は空入力を「判定不能」として
// fail closed（全 affected）に倒す規約を共有している。

/**
 * `env` は gh の実行環境。省略時は execFileSync の既定どおり process.env を継承する。
 * runUnit() は PR コードの依存へ GH_TOKEN を継承させないため process.env から
 * それを削除しており、その文脈から呼ぶ場合は token を含む env を明示的に渡す必要が
 * ある（渡さないと gh が「GH_TOKEN を設定してください」で失敗する）。
 * @param {{ repo?: string, prNumber?: string | number, execImpl?: ExecFileImpl, env?: NodeJS.ProcessEnv }} opts
 */
export function fetchPrFilenames({ repo, prNumber, execImpl = execFileSync, env } = {}) {
  if (!repo || !prNumber) return [];
  const out = execImpl(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${prNumber}/files`,
      '--jq',
      '.[] | .filename, (.previous_filename // empty)',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) },
  );
  return out.split('\n').filter(Boolean);
}

/**
 * migration safety の git fallback。`gh api` が使えない時に、base ref との two-dot diff から
 * `{ filename, status }` を組み立てる。shallow checkout でも動くよう merge-base（`...`）は使わず、
 * base ref が無ければ `git fetch --depth=1` を 1 回試す（public repo なので credential 不要）。
 * 判定できなければ null（呼び出し側が fail closed にする）。
 * @param {{ baseRef?: string, execImpl?: ExecFileImpl, spawnImpl?: SpawnImpl, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ filename: string, status: string }[] | null}
 */
export function fetchPrFilesFromGit({
  baseRef = `origin/${process.env.GITHUB_BASE_REF || 'main'}`,
  execImpl = execFileSync,
  spawnImpl = spawnSync,
  env,
} = {}) {
  const opts = { encoding: 'utf8', cwd: ROOT, ...(env ? { env } : {}) };
  const hasRef = () =>
    spawnImpl('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], opts).status ===
    0;
  if (!hasRef()) {
    const remote = baseRef.split('/')[0];
    const branch = baseRef.slice(remote.length + 1);
    spawnImpl('git', ['fetch', '--depth=1', remote, `${branch}:refs/remotes/${baseRef}`], opts);
    if (!hasRef()) return null;
  }
  let out;
  try {
    out = execImpl('git', ['diff', '--name-status', '-M', baseRef, 'HEAD'], opts);
  } catch {
    return null;
  }
  const STATUS = {
    A: 'added',
    M: 'modified',
    D: 'removed',
    R: 'renamed',
    C: 'added',
    T: 'modified',
  };
  const entries = [];
  for (const line of out.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const code = cols[0].trim().charAt(0);
    const filename = cols[cols.length - 1].trim();
    if (!filename) continue;
    entries.push({ filename, status: STATUS[code] ?? 'modified' });
  }
  return entries;
}

/**
 * migration safety（破壊的変更の静的スキャン）用。filename + status（NDJSON 由来）で返す。
 * `env` の扱いは fetchPrFilenames と同じ（省略時は process.env を継承）。
 * @param {{ repo?: string, prNumber?: string | number, execImpl?: ExecFileImpl, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ filename: string, status: string }[]}
 */
export function fetchPrFilesWithStatus({ repo, prNumber, execImpl = execFileSync, env } = {}) {
  if (!repo || !prNumber) return [];
  const out = execImpl(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${prNumber}/files`,
      '--jq',
      '.[] | {filename, status} | tojson',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) },
  );
  const entries = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 壊れた行はスキップする（check-destructive-migration.mjs の CLI と同じ扱い）
    }
  }
  return entries;
}

// ─── 判定（テスト対象の純粋関数）────────────────────────────────────
// GITHUB_OUTPUT / env はすべて文字列で渡ってくる（'true' | 'false'）。static
// モードは resolveImpact() の boolean を、test モードは env の文字列を渡すため、
// 両方を同じ規約で受けられるようにする。

function isTrueFlag(value) {
  return value === true || value === 'true';
}

function isFalseFlag(value) {
  return value === false || value === 'false';
}

/** docs-only の PR では静的解析の並列 lane（lint/knip/check:static/typecheck）を skip する。 */
export function shouldRunStaticLanes(docsOnly) {
  return !isTrueFlag(docsOnly);
}

/** CI toolchain の変更を含む PR では docs-only でも product unit test を走らせる。 */
export function shouldRunProductUnitTests(productUnit) {
  return !isFalseFlag(productUnit);
}

/** Protocol failures must fail the existing required unit job, not a detached advisory job. */
export function runMcpConformance(affected, execute = run) {
  if (!isFalseFlag(affected)) {
    execute('pnpm', ['--filter', '@dayopt/product', 'test:mcp:conformance']);
  }
}

/** DB を触らない PR では Supabase の起動自体を省略する（affected 判定）。 */
export function shouldRunIntegrationTests(integrationAffected) {
  return !isFalseFlag(integrationAffected);
}

// ─── product unit の範囲（PR では related、nightly で full）──────────────
//
// **product unit は Unit job 248 秒のうち 178 秒を占め、しかも PR push のたびに全件走っていた**
// （2026-09-14 実測、run 34792874608）。repo を private に戻すと Actions は分課金になり、
// 月の消費は 1 run の重さより回数（週 100 PR push）で決まる（docs/engineering/testing.md §予算）。
//
// PR では `vitest related <変更ファイル>` で、変更が import graph で届く test だけを走らせる。
// graph で追えない依存は 3 種類あり、それぞれ別の手で閉じる:
//
// 1. **build 済みで読む依存**（`packages/*` は dist 経由）・**設定 / test setup / toolchain** →
//    その path を含む PR は full に倒す（`PRODUCT_UNIT_TRACEABLE` にも `NEUTRAL` にも無い path は全部 full）
// 2. **src をファイルとして読む契約 test**（service role 境界など）→ `findFsReadingProductTests` が
//    `node:fs` を使う test を毎回見つけて、related とは別に必ず走らせる
// 3. **それでも漏れる経路**（削除した module を vi.mock 文字列で参照する等）→ nightly.yml の
//    `product-unit-full` が main を毎日 full で走らせる。検出の遅れは最大 1 日で、層 3 の E2E は
//    merge ごとに走る
//
// 判定できない時は必ず full（PR ファイル一覧が取れない / API 上限 / PR context が無い）。

/** related に渡せば import graph で追える path。`src/lib/test/` は setup を含むので除く。 */
function isProductUnitTraceable(file) {
  if (file.startsWith('apps/product/src/lib/test/')) return false;
  return (
    file.startsWith('apps/product/src/') ||
    file.startsWith('apps/product/messages/') ||
    (file.startsWith('scripts/') && !file.startsWith('scripts/ci/check.mjs'))
  );
}

/** product の unit test に届かないと分かっている path（届くか分からないものは入れない）。 */
function isProductUnitNeutral(file) {
  if (['AGENTS.md', 'CLAUDE.md', 'README.md'].includes(file)) return true;
  if (file === '.github/actions/setup/action.yml' || file === '.github/workflows/ci.yml') {
    return false;
  }
  return [
    'docs/',
    '.claude/',
    '.agents/',
    '.codex/',
    '.husky/',
    '.vscode/',
    '.github/',
    'apps/web/',
    'apps/storybook/',
    'supabase/',
  ].some((prefix) => file.startsWith(prefix));
}

/** GitHub の PR files API が返す上限。ちょうど届いたら一覧が切れている可能性がある。 */
const PR_FILES_API_LIMIT = 3000;

/**
 * @param {{ isPr: boolean, unitMode?: string, files: string[] | null }} input
 * @returns {{ scope: 'full', reason: string } | { scope: 'related', targets: string[], reason: string }}
 */
export function resolveProductUnitScope({ isPr, unitMode, files }) {
  if (unitMode === 'full') return { scope: 'full', reason: 'CI_UNIT_MODE=full' };
  if (!isPr) return { scope: 'full', reason: 'PR context が無い（schedule / dispatch）' };
  if (!files || files.length === 0) {
    return { scope: 'full', reason: 'PR のファイル一覧を取得できない' };
  }
  if (files.length >= PR_FILES_API_LIMIT) {
    return { scope: 'full', reason: `PR のファイル数が API 上限（${PR_FILES_API_LIMIT}）に届いた` };
  }

  const targets = [];
  for (const file of files) {
    if (isProductUnitTraceable(file)) targets.push(file);
    else if (!isProductUnitNeutral(file)) {
      return { scope: 'full', reason: `import graph で追えない変更を含む: ${file}` };
    }
  }
  return {
    scope: 'related',
    targets,
    reason: `変更 ${files.length} ファイル中 ${targets.length} ファイルから related を解決`,
  };
}

const FS_READ_PATTERN = /from ['"](?:node:)?fs(?:\/promises)?['"]|\breadFileSync\b|\breaddirSync\b/;

/**
 * product の unit test のうち、ファイルを fs で読むもの（import graph に乗らない依存を持つ）を返す。
 * integration test（`.integration.test.`）は別 job なので含めない。path は apps/product 基準。
 * @param {{ productDir?: string, readdirImpl?: typeof readdirSync, readFileImpl?: ReadFileImpl }} [opts]
 */
export function findFsReadingProductTests({
  productDir = join(ROOT, 'apps/product'),
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
} = {}) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirImpl(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        /\.test\.tsx?$/.test(entry.name) &&
        !entry.name.includes('.integration.test.') &&
        FS_READ_PATTERN.test(readFileImpl(path, 'utf8'))
      ) {
        found.push(relative(productDir, path).split('\\').join('/'));
      }
    }
  };
  walk(join(productDir, 'src'));
  return found.sort();
}

// ─── diff 範囲の解決（gitleaks / docs reminder で共有）────────────────
// PR の base SHA（`github.event.pull_request.base.sha`）が shallow clone に
// 存在しない場合は HEAD~1、それも無ければ HEAD まで段階的にフォールバックする
// （旧 docs-guard.yml の 2 箇所と同一規約）。

/** @param {string} ref @param {SpawnImpl} [execImpl] */
function refExists(ref, execImpl = spawnSync) {
  if (!ref) return false;
  const result = execImpl('git', ['cat-file', '-e', ref], { cwd: ROOT });
  return result.status === 0;
}

/** @param {{ candidate?: string, execImpl?: SpawnImpl }} [opts] */
export function resolveDiffBase({ candidate, execImpl = spawnSync } = {}) {
  if (refExists(candidate, execImpl)) return candidate;
  if (refExists('HEAD~1', execImpl)) return 'HEAD~1';
  return 'HEAD';
}

// ─── 汎用 exec ヘルパー ──────────────────────────────────────────────

/** @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} [opts] */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(`command failed (exit ${result.status}): ${cmd} ${args.join(' ')}`);
    err.exitCode = result.status ?? 1;
    throw err;
  }
}

/**
 * 独立したチェックを並列実行し、全完了を待ってから group 単位でログを出す
 * （旧 ci.yml の `&` / `wait` bash lane と同じ意図。node の spawn を使うのは
 * 実行ロジックを scripts 側へ寄せるため）。1 つでも失敗したら例外を投げる。
 * @param {{ label: string, cmd: string, args: string[] }[]} lanes
 */
async function runLanesInParallel(lanes) {
  const results = await Promise.all(
    lanes.map(
      (lane) =>
        new Promise((resolvePromise) => {
          const chunks = [];
          const child = spawn(lane.cmd, lane.args, { cwd: ROOT, shell: false });
          child.stdout.on('data', (d) => chunks.push(d));
          child.stderr.on('data', (d) => chunks.push(d));
          child.on('close', (code) => {
            resolvePromise({
              ...lane,
              code: code ?? 1,
              output: Buffer.concat(chunks).toString('utf8'),
            });
          });
          child.on('error', (error) => {
            resolvePromise({ ...lane, code: 1, output: String(error) });
          });
        }),
    ),
  );

  for (const { label, code, output } of results) {
    console.log(`\n::group::lane: ${label} (rc=${code})`);
    console.log(output);
    console.log('::endgroup::');
  }

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    console.log(
      `::error::static lane failed: ${failed.map((f) => `${f.label}(${f.code})`).join(', ')}`,
    );
    throw new Error(`static lanes failed: ${failed.map((f) => f.label).join(', ')}`);
  }
}

async function writeGithubOutput(lines) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${lines.join('\n')}\n`);
}

async function writeStepSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    console.log(markdown);
    return;
  }
  appendFileSync(path, `${markdown}\n`);
}

// ─── impact モード（判定だけを行う軽量 job。全 job の上流）────────────
//
// **静的検査より前に、単独の job として判定を出す**（2026-09-02、#2539 続き）。
// 分離前は static job が判定を持っていたため、判定を待つ unit / integration が
// static の完走（実測 4 分 20 秒）を直列で待っていた。判定自体は gh api 1 回 +
// 純関数で数秒しかかからず、`pnpm install` すら不要（impact.mjs は node 標準
// ライブラリと workspace の package.json しか読まない）。
//
// **fail-fast（static が落ちたら重い job を走らせない）を捨てる判断**は実測に
// 基づく: 直近 50 run で static job の failure は 0 件（success 28 / draft skip 20 /
// cancelled 1）だった。同じ検査を pre-push フックが先に走らせるため、CI で
// static が落ちる経路がほぼ塞がっている。**節約が一度も発動していない直列**の
// ために全 PR が 4 分待つのは割に合わない。
//
// なお static が落ちた時に unit が success になっても merge は通らない
// （finish-branch.sh が `🔍 Static Checks` の success を名前で要求する）。
// 並列化で緩むのは課金だけで、gate は緩まない。
async function runImpact() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const prNumber = process.env.PR_NUMBER;
  const isPr = eventName === 'pull_request' && !!prNumber;

  const filenames = isPr ? fetchPrFilenames({ repo, prNumber }) : [];
  const impact = resolveImpact(filenames);
  await writeStepSummary(formatImpactSummary(impact));

  // `functions_changed` は impact.mjs（app build への影響判定）の関心ではないため
  // ここで併せて出す。static job の deno check がこれを見る。`!isPr` を true 側へ
  // 倒すのは分離前の runStatic と同じ規約（workflow_dispatch では全部走らせる）。
  const functionsChanged = !isPr || filenames.some((f) => f.startsWith('supabase/functions/'));

  await writeGithubOutput([
    ...formatGithubOutput(impact).trim().split('\n'),
    `functions_changed=${functionsChanged}`,
  ]);
}

// ─── static モード ───────────────────────────────────────────────────

async function runStatic() {
  // impact 判定は上流の impact job が済ませており、ここでは env 経由で受け取る
  // （同一 PR の複数 job で gh api を叩いて結果がずれるのを避ける既存規約）。
  const docsOnly = process.env.DOCS_ONLY;
  const functionsChanged = process.env.FUNCTIONS_CHANGED;

  // ── secret scan（gitleaks、旧 docs-guard.yml）─────────────────────
  const GITLEAKS_VERSION = '8.30.1';
  const GITLEAKS_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
  run('bash', [
    '-c',
    `curl -sSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" && ` +
      `echo "${GITLEAKS_SHA256}  gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | sha256sum -c - && ` +
      `tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" gitleaks && ` +
      `sudo install -m 0755 gitleaks /usr/local/bin/gitleaks`,
  ]);

  const isPr = process.env.GITHUB_EVENT_NAME === 'pull_request' && !!process.env.PR_NUMBER;
  const diffBase = resolveDiffBase({
    candidate: process.env.PR_BASE_SHA || process.env.GITHUB_EVENT_BEFORE || '',
  });
  run('gitleaks', [
    'detect',
    '--source',
    '.',
    '--config',
    '.gitleaks.toml',
    '--redact',
    `--log-opts=${diffBase}..HEAD`,
    '--exit-code',
    '1',
  ]);
  run('bash', ['scripts/ci/gitleaks-allowlist-canary.sh']);

  if (isPr) {
    const diff = spawnSync('git', ['diff', '--name-only', `${diffBase}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const changed = (diff.stdout || '').split('\n').filter(Boolean);
    const srcChanged = changed.some((f) => f.startsWith('apps/product/src/'));
    const docsChanged = changed.some((f) => f.startsWith('docs/'));
    if (srcChanged && !docsChanged) {
      console.log(
        '::warning::apps/product/src/ に変更がありますが docs/ の更新がありません。仕様・運用・アーキテクチャへの影響がないか確認してください。',
      );
    }
  }

  run('pnpm', ['secrets:check']);
  run('pnpm', ['docs:check'], {
    env: {
      ...process.env,
      DOCS_GUARD_BASE_REF: `origin/${process.env.GITHUB_BASE_REF || 'main'}`,
    },
  });
  run('pnpm', ['--filter', '@dayopt/web', 'validate:content']);

  if (shouldRunStaticLanes(docsOnly)) {
    await runLanesInParallel([
      { label: 'ESLint', cmd: 'pnpm', args: ['lint'] },
      { label: 'Dead code', cmd: 'pnpm', args: ['quality:deadcode:ci'] },
      { label: 'Boundaries/format/i18n/taxonomy', cmd: 'pnpm', args: ['check:static'] },
      { label: 'TypeScript', cmd: 'pnpm', args: ['typecheck'] },
    ]);
  } else {
    console.log('docs-only の変更のため typecheck/lint/knip/check:static lane を skip します。');
  }

  // impact job が `!isPr`（workflow_dispatch）も込みで解決済み。ここでは
  // `!== 'false'` で受ける（空 = 判定不能なら実行する fail-closed 方向）。
  if (functionsChanged !== 'false') {
    const DENO_VERSION = '2.9.4';
    const DENO_SHA256 = 'c24f955d9fbfe0ea5ae2b501c8e71ae76e31e4c9782390a54a284b3364fda725';
    run('bash', [
      '-c',
      `curl -sSLO "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" && ` +
        `echo "${DENO_SHA256}  deno-x86_64-unknown-linux-gnu.zip" | sha256sum -c - && ` +
        `mkdir -p "$RUNNER_TEMP/deno-bin" && unzip -q deno-x86_64-unknown-linux-gnu.zip -d "$RUNNER_TEMP/deno-bin" && ` +
        `echo "$RUNNER_TEMP/deno-bin" >> "$GITHUB_PATH"`,
    ]);
    // GITHUB_PATH への追記は次 step から効くため、この step 内で使うには PATH を
    // 自前で通す必要がある。
    run('bash', ['-c', 'export PATH="$RUNNER_TEMP/deno-bin:$PATH" && pnpm functions:check']);
  }
}

// ─── unit モード（DB 非依存。Supabase を起動しない job で走る）────────

async function runUnit() {
  // ── GH_TOKEN を PR コードの依存から隔離する ────────────────────────
  // **この job の token は read-only**（contents: read / pull-requests: read）。
  // PR head のコードと全依存を実行する job に書き込み token を置かないため、
  // 破壊的 migration のラベル付与・コメント投稿は ci.yml の `migration-notice` job
  // （checkout も依存 install もしない）へ移した（2026-09-14、credential audit P2-6。
  // それ以前はこの job が pull-requests: write / issues: write を持ち、ここでの押収だけが
  // 防御だった。PR #2484 の P1 指摘）。read-only でも PR の変更ファイル一覧を読める
  // token であることに変わりはないため、以降の run()（postinstall・vitest transform・
  // plugin を含む）へ継承させない押収は残す。押収した値は migration safety の
  // ファイル一覧取得にだけ明示的に渡す。
  const ghToken = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;

  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const prNumber = process.env.PR_NUMBER;
  const isPr = eventName === 'pull_request' && !!prNumber;

  const productUnit = shouldRunProductUnitTests(process.env.PRODUCT_UNIT);

  // ── migration safety（破壊的変更の静的スキャン、常時・DB 不要）────
  // 他の unit test より先に実行する。DB 起動も build:packages も不要な軽い
  // 静的スキャンで、後段の unit test 失敗（run() が例外を投げて runUnit を
  // 中断する）に巻き込まれて検知そのものが飛ぶのを防ぐ（内製クロスレビュー
  // risk-reviewer 指摘、P2、PR #2484）。
  //
  // **integration job ではなく unit job に置く**。integration job は affected な
  // PR でしか走らないが、この検知は「新規 migration を含む PR」で必ず要る。
  // 両者の条件は現状ほぼ一致する（migrations/** は INTEGRATION_GLOBS に入っている）
  // が、glob を締める変更（#2539 の後続）で乖離しうるため、常時走る側へ置く。
  // coupled migration（既存オブジェクトの契約を縮める migration + product runtime 変更が
  // 同一 PR）だけは hard fail にする（#2680。2026-09-08 に #2672 で旧 build が revoke 済み
  // schema に 5 時間当たり続けた）。ただし throw は他の unit test を全部走らせた**後**に
  // 行う。検知を先頭へ置いた理由（test 失敗に巻き込まれない）を保つため。
  let coupledMigration = null;
  let migrationSafetyUndeterminable = false;
  if (isPr) {
    const safety = await runMigrationSafety({
      repo,
      prNumber,
      env: { ...process.env, GH_TOKEN: ghToken },
    });
    if (safety.coupled) coupledMigration = safety.coupling;
    if (safety.undeterminable) migrationSafetyUndeterminable = true;
    // 通知（ラベル + コメント）は write 権限を持つ下流 job が行う。unit test の失敗で
    // step が落ちても GITHUB_OUTPUT は step 終了時に処理されるため、検知直後に書く。
    await writeGithubOutput(formatMigrationSafetyOutput(safety));
  }

  run('pnpm', ['build:packages']);
  run('pnpm', ['test:scripts']);
  run('pnpm', [
    '--dir',
    'apps/product',
    'exec',
    'vitest',
    '--project',
    'unit',
    'run',
    'production-build-gate.test.mjs',
  ]);
  run('pnpm', ['--dir', 'apps/web', 'exec', 'vitest', 'run', 'production-build-gate.test.mjs']);

  if (productUnit) {
    runProductUnit({ isPr, repo, prNumber, ghToken });
  } else {
    console.log('product 影響なしのため product unit test を skip します。');
  }
  runMcpConformance(process.env.MCP_CONFORMANCE);
  run('pnpm', ['test:web']);
  run('pnpm', ['--filter', '@dayopt/billing', 'test:run']);
  run('pnpm', ['--filter', '@dayopt/i18n', 'test:run']);
  run('pnpm', ['--filter', '@dayopt/observability', 'test:run']);

  if (migrationSafetyUndeterminable) {
    throw new Error(
      '::error::migration safety: PR のファイル一覧を gh api でも git diff でも取得できず、coupled migration の判定ができません。再実行するか、token / checkout の配線を確認してください（#2680）。',
    );
  }
  if (coupledMigration) {
    throw new Error(
      `::error::coupled migration: 既存オブジェクトの契約を縮める migration と product の runtime 変更が同一 PR にあります。` +
        `app コードだけの PR を先に出荷し、migration は別 PR にしてください（Step Summary / PR コメントの「Coupled migration」参照、#2680）。` +
        ` 縮小: ${coupledMigration.narrowing.map((f) => `${f.kind} ${f.target}`).join(', ')}`,
    );
  }
}

/**
 * product の unit test を PR では related + fs 契約 test、それ以外は full で走らせる
 * （判定の設計は resolveProductUnitScope の上のコメント）。
 */
function runProductUnit({ isPr, repo, prNumber, ghToken }) {
  let files = null;
  if (isPr) {
    try {
      files = fetchPrFilenames({ repo, prNumber, env: { ...process.env, GH_TOKEN: ghToken } });
    } catch (error) {
      console.log(
        `::notice::PR のファイル一覧を取得できないため product unit を full で走らせます: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const decision = resolveProductUnitScope({
    isPr,
    unitMode: process.env.CI_UNIT_MODE,
    files,
  });

  if (decision.scope === 'full') {
    console.log(`product unit: full（${decision.reason}）`);
    run('pnpm', ['--filter', '@dayopt/product', 'test:run']);
    return;
  }

  const fsTests = findFsReadingProductTests();
  console.log(
    `product unit: related（${decision.reason}）+ fs を読む契約 test ${fsTests.length} 件`,
  );
  if (decision.targets.length > 0) {
    run('pnpm', [
      '--dir',
      'apps/product',
      'exec',
      'vitest',
      'related',
      ...decision.targets.map((file) => join(ROOT, file)),
      '--project',
      'unit',
      '--project',
      'unit-dom',
      '--run',
      '--passWithNoTests',
    ]);
  }
  if (fsTests.length > 0) {
    run('pnpm', [
      '--dir',
      'apps/product',
      'exec',
      'vitest',
      '--project',
      'unit',
      '--project',
      'unit-dom',
      'run',
      ...fsTests,
    ]);
  }
}

// ─── integration モード（Supabase 起動済みの job で走る）──────────────

async function runIntegration() {
  // このモードは gh を一切呼ばないため、ci.yml 側も GH_TOKEN を渡さない
  // （unit job のような押収・再注入が要らないよう、そもそも env に置かない設計）。
  //
  // ci.yml の job `if:` が既に affected 判定で job ごと skip するが、ここでも
  // 同じ向き（判定不能なら実行 = fail closed）で確認する。guard の向きが 2 箇所で
  // 食い違っていると、将来の配線変更でサイレントに壊れるため（既存 ci.yml の
  // コメントと同じ設計判断）。
  if (!shouldRunIntegrationTests(process.env.INTEGRATION_AFFECTED)) {
    console.log('DB を触らない変更のため integration/RLS test を skip します。');
    return;
  }

  run('pnpm', ['test:integration']);
  run(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SET app.isolated_validation = on',
      '-f',
      'supabase/tests/cron-heartbeats.sql',
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  run('pnpm', ['rls:snapshot:check']);
  run('pnpm', ['types:generate:local']);
  run('git', [
    'diff',
    '--exit-code',
    '--',
    'apps/product/src/lib/database/generated/database.types.ts',
  ]);
}

/**
 * migration safety の検知。plain な destructive 検知は「検知しても job は失敗させない」
 * （fail open）設計を維持する。戻り値の `coupled`（既存オブジェクトの契約を縮める migration と
 * product runtime 変更が同一 PR、#2680）だけは呼び出し側（runUnit）が hard fail にする。
 *
 * **通知（ラベル付与・PR コメント）はここでは行わない**（2026-09-14、credential audit P2-6）。
 * この関数は PR head のコードと全依存を実行する unit job で走るため、write 権限の token を
 * 持たせない。`notify` と `summary` を返し、runUnit が formatMigrationSafetyOutput() で
 * job output へ出し、ci.yml の `migration-notice` job（checkout も依存 install もしない）が
 * コメント投稿 → ラベル付与を行う（順序と「付与済みなら再通知しない」規約はそちらが持つ）。
 *
 * 実行に使う関数はすべて注入可能にしてある（test では gh / fs へ実際に触れずに
 * 分岐を検証する。strip-status-labels.mjs と同じ DI の型）。
 * @param {{
 *   repo?: string,
 *   prNumber?: string | number,
 *   fetchFilesImpl?: typeof fetchPrFilesWithStatus,
 *   readFileImpl?: ReadFileImpl,
 *   writeStepSummaryImpl?: typeof writeStepSummary,
 *   gitFallbackImpl?: typeof fetchPrFilesFromGit,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 */
export async function runMigrationSafety({
  repo,
  prNumber,
  fetchFilesImpl = fetchPrFilesWithStatus,
  readFileImpl = readFileSync,
  writeStepSummaryImpl = writeStepSummary,
  gitFallbackImpl = fetchPrFilesFromGit,
  sleepImpl = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  env = process.env,
}) {
  // env はファイル一覧取得の gh 呼び出しへ渡す。runUnit() が process.env から
  // GH_TOKEN を外しているため、渡し漏らすと gh が「GH_TOKEN を設定してください」で失敗する。
  //
  // 取得失敗は fail open に倒す（内製クロスレビュー risk-reviewer 指摘、P2）。
  // この呼び出しは #2483 で unit test 群より前へ移したため、例外を素通しすると
  // GitHub API の一時障害・rate limit・fork PR の権限差で「テストを 1 本も
  // 走らせないまま Unit Tests job が落ちる」形になる（実際に PR #2484 の
  // run 33181021085 がこの形で落ちた）。migration safety は検知しても job を
  // 落とさない契約なので、取得できなかった時も同じ向き（続行）へ倒し、
  // 見落としの可能性だけを Step Summary へ残す。
  //
  // ただし coupled 判定（#2680）は hard fail の保証なので、取得失敗で黙って gate が開く
  // 形にはしない（push 前反証レビュー指摘、P2）: gh api を 1 回だけ再試行し、それでも
  // 駄目なら base ref との git diff で代替する。どちらも判定できなければ `undeterminable`
  // を返し、呼び出し側（runUnit）が unit test 完走後に job を落とす（再実行で直る
  // 一時障害なら再実行、token 配線の壊れなら「静かに失効したガードレール」ではなく
  // 赤い job として見える）。
  let files;
  let fallbackNote = '';
  try {
    files = fetchFilesImpl({ repo, prNumber, env });
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : String(error);
    try {
      await sleepImpl(1500);
      files = fetchFilesImpl({ repo, prNumber, env });
    } catch {
      const fromGit = gitFallbackImpl({ env });
      if (fromGit === null) {
        await writeStepSummaryImpl(
          `## Migration safety\n\n` +
            `❌ PR のファイル一覧を gh api（再試行 1 回）でも git diff でも取得できなかったため、` +
            `破壊的 migration の検知と coupled migration の判定ができません。Unit Tests job は失敗扱いにします（再実行で直る一時障害か、token / checkout の配線を確認する。#2680）。\n\n` +
            `\`\`\`\n${firstMessage}\n\`\`\`\n`,
        );
        return {
          results: [],
          notify: false,
          summary: '',
          skipped: true,
          coupled: false,
          undeterminable: true,
        };
      }
      files = fromGit;
      fallbackNote = `\n> ⚠️ PR のファイル一覧は gh api が失敗したため base ref との git diff で代替した（${firstMessage.slice(0, 160)}）。\n`;
    }
  }
  const withContent = files
    .filter((f) => f.filename.startsWith('supabase/migrations/') && f.filename.endsWith('.sql'))
    .map((f) => {
      let content = '';
      try {
        content = readFileImpl(resolve(ROOT, f.filename), 'utf8');
      } catch {
        content = ''; // 削除・rename されたファイル等
      }
      return { path: f.filename, status: f.status, content };
    });

  const results = detectDestructiveMigrations(withContent);
  // coupled 判定は「PR で追加された migration」×「PR の全変更ファイル」で行う。
  // narrowing ⊂ destructive なので、results が空なら coupled も必ず false。
  const coupling = evaluateCoupledMigration({
    addedMigrations: withContent.filter((f) => f.status === 'added'),
    prFiles: files.map((f) => f.filename),
  });
  const summary =
    formatMigrationSummary(results) +
    fallbackNote +
    (coupling.coupled ? `\n${formatCoupledSummary(coupling)}` : '');
  await writeStepSummaryImpl(summary);
  return { results, notify: results.length > 0, summary, coupled: coupling.coupled, coupling };
}

/**
 * runMigrationSafety の結果を GITHUB_OUTPUT の行へ変換する。受け手は ci.yml の
 * `migration-notice` job で、`migration_destructive` は `true` / `false` の 2 値だけ、
 * コメント本文は改行や delimiter を含みうる markdown なので 1 行の base64 にする
 * （複数行 output の heredoc delimiter を本文で偽装されない形にするため）。
 * 受け手はこの output を「PR head のコードが書いた値」として allowlist で検証する。
 * @param {{ notify?: boolean, summary?: string }} safety
 * @returns {string[]}
 */
export function formatMigrationSafetyOutput(safety) {
  const notify = safety?.notify === true && typeof safety.summary === 'string';
  return [
    `migration_destructive=${notify ? 'true' : 'false'}`,
    `migration_comment_b64=${notify ? Buffer.from(safety.summary, 'utf8').toString('base64') : ''}`,
  ];
}

// ─── CLI ────────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const mode = process.argv[2];
  try {
    if (mode === 'impact') {
      await runImpact();
    } else if (mode === 'static') {
      await runStatic();
    } else if (mode === 'unit') {
      await runUnit();
    } else if (mode === 'integration') {
      await runIntegration();
    } else {
      console.error('Usage: node scripts/ci/check.mjs <impact|static|unit|integration>');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode ?? 1;
  }
}
