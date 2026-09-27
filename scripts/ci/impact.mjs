#!/usr/bin/env node

/**
 * Impact Resolver — 変更ファイル一覧から「どの検証・build・release が必要か」を判定する。
 *
 * CI の手書き paths、merge gate（finish-branch.sh）、Production Release、Vercel の
 * Ignored Build Step が**同じ規則**を共有するための単一の正本
 * （旧 docs/projects/_archive/ci-monorepo-refactor/overview.md §5、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
 *
 * 使い方:
 *   printf '%s\n' file1 file2 | node scripts/ci/impact.mjs --stdin
 *   node scripts/ci/impact.mjs apps/product/src/foo.ts docs/README.md
 *   ... --summary を付けると GITHUB_STEP_SUMMARY 向けの Markdown を出す
 *   ... --github-output を付けると GITHUB_OUTPUT 向けの `key=value` 行を出す
 *   node scripts/ci/impact.mjs --vercel <product|web>
 *   ... Vercel の Ignored Build Step（`ignoreCommand`）から呼ぶ専用モード。
 *       `apps/{product,web}/vercel.json` を参照。詳細は §Vercel Ignored Build Step。
 *
 * 出力キーは固定: product / web / integration / productJourney / webPreviewSmoke / docsOnly。
 *
 * 判定の原則:
 * - **未知の path は fail closed（全 affected）**。判定漏れが検証漏れに化けるのを防ぐ。
 *   新しい root ファイルを足した時は本ファイルの分類へ明示的に追加する
 * - workspace 依存グラフは pnpm manifest（dependencies / devDependencies の @dayopt/*）
 *   から実行時に解決する。package 追加時に判定が自動追従し、対応表の腐りを防ぐ。
 *   読むのは**本ファイルを実行している checkout の manifest**（merge gate では通常
 *   main checkout）。PR 側の manifest 変更は直接見ないが、新しい依存 edge を作る
 *   変更は manifest ファイル自体（apps/** または packages/**）に触れるため、その
 *   ファイルの分類で当該 app が affected になり、判定漏れにはならない
 * - 変更ファイルが 1 件も無い入力は判定不能として fail closed（全 affected）に倒す
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 出力キー。消費側（finish-branch.sh / release / CI）はこの集合に依存する。 */
/**
 * production に適用される root の migration ファイル（`_archive/` や README は含まない）。
 * `🧱 DB Upgrade (shadow)` の起動（check.mjs の `migrations_added`）と plan の
 * dbUpgrade / oldConsumer は必ずこの 1 本を共有する（判定がずれると plan が要求する job が
 * 起動せず Validation が恒久的に blocked になる）。
 */
export const ROOT_MIGRATION_PATH = /^supabase\/migrations\/\d{14}_.+\.sql$/;

export const IMPACT_KEYS = [
  'product',
  'web',
  'integration',
  'productJourney',
  'productUnit',
  'webCi',
  'webPreviewSmoke',
  'docsOnly',
  'mcpConformance',
];

// ─── docs 系（app build に影響しない）────────────────────────────────
// ci.yml の paths-ignore と同一規則。片方だけ直すと「CI は skip したのに
// merge gate は build を要求する」ズレが出るため、変更時は両方を揃える。
const DOCS_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);

function isDocsPath(file) {
  if (DOCS_FILES.has(file)) return true;
  if (file.startsWith('docs/')) return true;
  if (
    ['.claude/', '.agents/', '.codex/'].some((prefix) => file.startsWith(prefix)) &&
    file.endsWith('.md')
  ) {
    return true;
  }
  return false;
}

// ─── integration（server contract / DB 境界）────────────────────────
// #2483（CI ファイル統合 Phase 1）以前は旧 integration.yml 自身が持つ
// hand-written `paths:` フィルタが per-PR 実行可否を決めており、この
// INTEGRATION_GLOBS はその YAML と重複させた上で contract test（当時の
// scripts/__tests__/impact.test.ts）が同期を強制していた。#2483 で
// integration の per-PR 実行が「ci.yml の integration job が
// `shouldRunIntegrationTests()`（check.mjs）を通じてこの判定結果を読む」形へ
// 一本化されたため、**この INTEGRATION_GLOBS が per-PR 実行可否の唯一の定義**
// になった——同期すべき別の YAML paths: リストはもう存在しない（2026-09-03 に
// nightly.yml の integration job も撤去し、per-PR 実行が唯一の経路になった）。
//
// 判定結果（resolveImpact().integration）は $GITHUB_OUTPUT 経由で ci.yml の
// integration job（`needs.impact.outputs.integration`）へ渡り、Supabase 起動と
// integration/RLS test の実行可否を決める（#1815 で見送った gate job 化は
// この統合で解消済み——affected 判定はもう workflow trigger と別建てではない）。
//
// **integration の配線そのものを持つファイルを含める**（`.github/workflows/ci.yml` /
// `scripts/ci/check.mjs`、2026-09-02 #2539 の job 分割で追加）。これらを変更した PR で
// integration=false になると、**配線を変えた当の job を一度も実走させないまま merge**
// できてしまう。`.github/workflows/nightly.yml` も残してある——2026-09-03 に
// integration job は撤去したが、`.github/actions/setup` などの共有部品を経由して
// 影響しうるため、過剰発火側（安全側）に倒したまま据え置く。
//
// **このファイル自身（impact.mjs）は意図的に中立のまま**（内製クロスレビュー
// risk-reviewer 指摘、P3）。INTEGRATION_GLOBS を締める変更だけを含む PR は
// integration=false になり、新しい glob の下で integration job が走らない。
// 保証境界は `scripts/ci/impact.test.ts` — この判定器の unit test は unit job で
// 必ず走るため、glob の誤りは integration の実走を待たずに検出される。
// 自己参照で全 PR に Supabase 起動を強いるより、判定器の test を厚くする側を採る。
export const INTEGRATION_GLOBS = [
  '.nvmrc',
  'package.json',
  'pnpm-lock.yaml',
  'apps/product/package.json',
  '.github/actions/setup/action.yml',
  '.github/workflows/nightly.yml',
  '.github/workflows/ci.yml',
  'scripts/ci/check.mjs',
  'scripts/tasks/generate-database-types.mjs',
  'apps/product/src/features/*/domain/**',
  'apps/product/src/features/*/server/**',
  'apps/product/src/lib/time/**',
  'apps/product/src/lib/database/**',
  'apps/product/src/lib/mcp/**',
  'apps/product/src/lib/oauth-server/**',
  'apps/product/src/lib/supabase/**',
  'apps/product/src/lib/trpc/**',
  'apps/product/src/app/api/mcp/**',
  'supabase/migrations/**',
  'apps/product/src/lib/test/integration/**',
  'apps/product/src/lib/test/integration-setup.ts',
  'apps/product/src/lib/test/trpc-test-helpers.ts',
  'apps/product/vitest.config.integration.ts',
  'scripts/tasks/generate-rls-snapshot.ts',
  'scripts/lib/storage-objects-app-policy-names.mjs',
  'docs/engineering/data/db/rls-snapshot.md',
];

/**
 * Actions の paths と同じ意味論の最小 glob。`*` は 1 セグメント内、`**` は任意深さ。
 * 依存を増やさないため自前実装（対象はこのファイル内の固定パターンのみ）。
 */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`);
}

const INTEGRATION_MATCHERS = INTEGRATION_GLOBS.map(globToRegExp);

function isIntegrationPath(file) {
  return INTEGRATION_MATCHERS.some((re) => re.test(file));
}

// ─── root 設定（両 app の build に影響する）──────────────────────────
// turbo.json の globalDependencies と install / toolchain の入力を含める。
// `.npmrc` は pnpm の依存解決設定（auto-install-peers / strict-peer-dependencies）を
// 持ち、両 app の install 結果＝build 対象を左右する。lockfile の diff を伴わない
// 単独変更がありうるため、中立に倒すと install 起因の build 失敗を検証しないまま
// merge できてしまう（product の build は Actions に無く Vercel だけが持つ）。
const ROOT_BUILD_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  '.nvmrc',
  '.npmrc',
  'eslint.config.packages.mjs',
]);

// ─── Vercel の build が実行する root script ───────────────────────────
// `apps/product/vercel.json` の buildCommand が `pnpm verify:bundle` を呼び、それが
// root の `scripts/` を直接実行する。`scripts/` 全体を中立に倒すと、この検証スクリプト
// 自体を変更した PR が product=false になり、**変更した当の検証を一度も走らせないまま**
// merge できてしまう（Vercel build がその PR で走らないため）。
// 追加漏れ（drift）は `scripts/__tests__/impact.test.ts` が manifest から導出して検査する。
export const PRODUCT_BUILD_SCRIPTS = new Set([
  'scripts/tasks/check-client-bundle-secrets.mjs',
  'scripts/tasks/check-bundle-budget.ts',
]);

// web の buildCommand（`pnpm generate:search-index && pnpm build`）が呼ぶのは
// `apps/web/scripts/generate-search-index.ts` で、`apps/web/` prefix で既に拾える。

// ─── CI の toolchain（Actions 上で test が動く runtime を決める）──────
//
// `.github/` は下の isNeutralPath で丸ごと中立扱いになるが、setup action だけは
// **Actions 上で product の unit test が動く Node / pnpm のバージョンそのもの**を決める。
// ここを中立にすると、Node を上げる PR で product の unit test が skip され、
// 「runtime を変えたのに、その runtime で product の test を一度も走らせないまま merge」
// になる（実際に `chore(node): ランタイムをNode.js 24へ統一` という commit が存在する）。
//
// **`product` ではなく専用キー（`productUnit`）に倒すのが要点。** この file は Vercel の
// build env には一切影響しないため、`product=true` にすると merge gate が
// `Vercel – product` context を要求し、Phase 4 で止めた preview build を復活させてしまう。
//
// `.github/workflows/ci.yml` は**あえて含めない**。ci.yml を変更した PR ではその新しい
// ci.yml 自体が実行されるので、gate 判定・job 構成・無条件 step は全て検証される。
// 検証されずに残るのは skip された step の中身（1 行の pnpm 呼び出し）だけで、
// これを拾うために product=false な PR の 1/3（実測 19 件中 7 件）で skip を諦めるのは割に合わない。
const CI_TOOLCHAIN_FILES = new Set(['.github/actions/setup/action.yml']);

// ─── 中立（appの成果物に影響しない既知の path）──────────────────────
// ここに入れてよいのは「app の build 成果物・runtime 挙動を変えない」ものだけ。
// 迷ったら入れない（未知扱い = fail closed の側に倒れる）。
function isNeutralPath(file) {
  const prefixes = [
    'scripts/', // CI / release / 開発補助。app へ bundle されない
    '.github/', // workflow 定義（integration 対象の path は先に判定済み）
    '.claude/', // provider adapter
    '.agents/', // shared skills
    '.codex/', // provider adapter
    '.husky/',
    '.vscode/',
    'apps/storybook/', // 開発者向け。Vercel の product / web project に含まれない
  ];
  if (prefixes.some((p) => file.startsWith(p))) return true;
  const rootNeutral = new Set([
    '.gitignore',
    '.gitattributes',
    '.prettierrc',
    '.prettierignore',
    'commitlint.config.mjs',
    'eslint.config.mjs',
    'vitest.scripts.config.ts',
    'LICENSE',
    // 以下はいずれも **static / scripts の検査が入力として読む設定**で、app の bundle にも
    // runtime 挙動にも入らない。未分類のままだと `impact.unknown` に載り、
    // validation-plan 側で `databaseTests` が applicable になって migration の無い PR が
    // 隔離 Supabase branch を待って恒久 blocked になる（#2811 / PR #2868）。
    '.gitleaks.toml', // secret scan の設定。読むのは ci.yml の static job
    '.boundary-budget.json', // lint:boundaries の予算。読むのは scripts/tasks/boundaries
    '.op-env.agent.example', // secret 台帳の例示。ci-secret-ledger.test.ts が読む
    '.op-env.human.example',
    'lint-staged.config.mjs', // pre-commit の整形。CI の build には入らない
    'tsconfig.scripts.json', // scripts/ の typecheck 専用（app は tsconfig.base.json）
  ]);
  return rootNeutral.has(file);
}

// ─── workspace 依存グラフ ───────────────────────────────────────────

/**
 * `packages/<dir>` ごとに「どの app が（推移的に）依存しているか」を返す。
 * 対応表をハードコードしない: manifest の @dayopt/* を辿るため、package の
 * 追加・依存変更に自動追従する。
 *
 * @returns {Map<string, Set<'product' | 'web'>>} key は `packages/<dir>`
 */
export function readWorkspaceGraph(root = ROOT) {
  const readManifest = (dir) => {
    try {
      return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  /** @type {Map<string, { dir: string, deps: string[] }>} name -> manifest 情報 */
  const packagesByName = new Map();
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/${entry.name}`;
    const manifest = readManifest(dir);
    if (!manifest?.name) continue;
    const deps = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter((name) => name.startsWith('@dayopt/'));
    packagesByName.set(manifest.name, { dir, deps });
  }

  const reachableFrom = (appDir) => {
    const manifest = readManifest(appDir);
    const queue = Object.keys({
      ...manifest?.dependencies,
      ...manifest?.devDependencies,
    }).filter((name) => name.startsWith('@dayopt/'));
    const seen = new Set();
    while (queue.length > 0) {
      const name = queue.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const pkg = packagesByName.get(name);
      if (pkg) queue.push(...pkg.deps);
    }
    return seen;
  };

  const productDeps = reachableFrom('apps/product');
  const webDeps = reachableFrom('apps/web');

  const graph = new Map();
  for (const [name, { dir }] of packagesByName) {
    const apps = new Set();
    if (productDeps.has(name)) apps.add('product');
    if (webDeps.has(name)) apps.add('web');
    graph.set(dir, apps);
  }
  return graph;
}

// ─── 判定本体 ───────────────────────────────────────────────────────

const ALL_AFFECTED = {
  product: true,
  web: true,
  integration: true,
  productJourney: true,
  productUnit: true,
  webCi: true,
  webPreviewSmoke: true,
  docsOnly: false,
  mcpConformance: true,
};

/**
 * @param {string[]} changedFiles repo-root 相対の変更ファイル一覧
 * @param {{ graph?: Map<string, Set<string>> }} [options] test 用の依存グラフ注入
 */
export function resolveImpact(changedFiles, options = {}) {
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);

  // 空入力は「判定できない」であって「影響なし」ではない。fail closed に倒す。
  if (files.length === 0) {
    return {
      ...ALL_AFFECTED,
      reasons: { product: '(判定不能: 変更ファイル一覧が空。fail closed)' },
      unknown: [],
    };
  }

  const graph = options.graph ?? readWorkspaceGraph();

  let product = false;
  let web = false;
  let integration = false;
  let ciToolchain = false;
  let docsOnly = true;
  let mcpConformance = false;
  /** @type {Record<string, string>} 各キーを最初に true にしたファイル（説明用） */
  const reasons = {};
  /** @type {string[]} どの規則にも該当しなかったファイル */
  const unknown = [];

  const mark = (key, file) => {
    if (!reasons[key]) reasons[key] = file;
  };

  for (const file of files) {
    // Include dependency manifests/lockfile conservatively: SDK transitive changes
    // can alter the advertised protocol even when application code is unchanged.
    if (
      file.startsWith('apps/product/src/app/api/mcp/') ||
      file.startsWith('apps/product/src/app/mcp/') ||
      file.startsWith('apps/product/src/lib/mcp/') ||
      file.startsWith('apps/product/src/lib/oauth-server/') ||
      file.startsWith('apps/product/scripts/mcp-conformance') ||
      [
        'apps/product/package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
        'scripts/ci/impact.mjs',
        'scripts/ci/check.mjs',
        '.github/workflows/ci.yml',
      ].includes(file) ||
      CI_TOOLCHAIN_FILES.has(file)
    ) {
      mcpConformance = true;
      mark('mcpConformance', file);
    }
    // integration は docs とも app とも独立に判定する（rls-snapshot.md のように
    // docs パスが integration の対象になるものがあるため、先に見る）。
    if (isIntegrationPath(file)) {
      integration = true;
      mark('integration', file);
    }

    // CI toolchain も docs / app とは独立に判定する（`.github/` は下で中立に落ちるため先に見る）。
    if (CI_TOOLCHAIN_FILES.has(file)) {
      ciToolchain = true;
      mark('productUnit', file);
    }

    if (isDocsPath(file)) continue; // docsOnly を維持

    docsOnly = false;

    if (file.startsWith('apps/product/')) {
      product = true;
      mark('product', file);
      continue;
    }
    if (file.startsWith('apps/web/')) {
      web = true;
      mark('web', file);
      continue;
    }
    if (file.startsWith('supabase/')) {
      product = true;
      integration = true;
      mark('product', file);
      mark('integration', file);
      continue;
    }
    if (file.startsWith('packages/')) {
      const dir = file.split('/').slice(0, 2).join('/');
      const apps = graph.get(dir);
      if (!apps) {
        unknown.push(file); // 未知 package は fail closed
        continue;
      }
      if (apps.has('product')) {
        product = true;
        mark('product', file);
      }
      if (apps.has('web')) {
        web = true;
        mark('web', file);
      }
      continue;
    }
    // `patches/**` は pnpm の `patchedDependencies` が install 時に当てるので、両 app の
    // node_modules ＝ build 対象を変える。中立ではなく **両 app 影響**（未分類のままだと
    // `unknown` に載り、migration の無い PR が隔離 DB を待って恒久 blocked になる）。
    if (ROOT_BUILD_FILES.has(file) || file.startsWith('patches/')) {
      product = true;
      web = true;
      mark('product', file);
      mark('web', file);
      continue;
    }
    // isNeutralPath より先に見る（どちらも scripts/ に該当するため）
    if (PRODUCT_BUILD_SCRIPTS.has(file)) {
      product = true;
      mark('product', file);
      continue;
    }
    if (isNeutralPath(file)) continue;

    unknown.push(file);
  }

  if (unknown.length > 0) {
    // 未知 path の fail closed。docsOnly も false にする（docs と未知の混在を
    // 「docs のみ」と誤判定して build を skip しないため）。
    return {
      ...ALL_AFFECTED,
      reasons: {
        ...reasons,
        product: reasons.product ?? unknown[0],
        web: reasons.web ?? unknown[0],
      },
      unknown,
    };
  }

  return {
    product,
    web,
    integration,
    // journey / smoke は現状 app 影響と同値。Phase 5 で E2E の実行判定に使う
    // 独立キーとして先に固定しておく（消費側の contract を後から変えない）。
    productJourney: product,
    // Actions 上で product の unit test を走らせるか。app 影響に加えて CI toolchain の
    // 変更でも true にする（§CI の toolchain）。Vercel / release は `product` を見るため、
    // toolchain 変更が preview build を誘発しない。
    productUnit: product || ciToolchain,
    // Actions 上で web の build + E2E job を走らせるか。productUnit と同じ理由で
    // `web` から分ける: この job も同じ setup action（Node / pnpm のバージョン）で
    // 動くため toolchain 変更でも走らせたいが、`web` に倒すと Vercel の web preview
    // build まで誘発してしまう（Phase 4 で止めたもの）。
    webCi: web || ciToolchain,
    webPreviewSmoke: web,
    docsOnly,
    mcpConformance,
    reasons,
    unknown,
  };
}

// ─── Markdown summary（GITHUB_STEP_SUMMARY 向け）────────────────────

export function formatSummary(impact) {
  const row = (key) => {
    const value = impact[key] ? '✅ 必要' : '⬜ skip';
    const reason = impact.reasons?.[key] ? ` — \`${impact.reasons[key]}\`` : '';
    return `| ${key} | ${value}${reason} |`;
  };
  const lines = [
    '## Impact Resolver',
    '',
    '| 対象 | 判定 |',
    '| --- | --- |',
    ...IMPACT_KEYS.map((key) =>
      key === 'docsOnly' ? `| docsOnly | ${impact.docsOnly ? '✅' : '⬜'} |` : row(key),
    ),
  ];
  if (impact.unknown?.length > 0) {
    lines.push(
      '',
      `⚠️ 未知の path を検出したため fail closed（全 affected）: ${impact.unknown
        .map((f) => `\`${f}\``)
        .join(', ')}`,
      '分類は `scripts/ci/impact.mjs` に追加する。',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── GitHub Actions の job output（`--github-output`）─────────────────
//
// ci.yml の gate job が各 job / step の `if:` に配る値。**判定の既定値を YAML の
// shell one-liner ではなくここに置く**のは、YAML に書いた分岐は test に載らないため
// （実際に「テストを足しても CI に載らない」形の穴が過去にあった）。
//
// キーごとに fail closed の向きが逆になる点に注意する:
// - `docs_only` は true が skip 側なので、確信が持てない時は false
// - `product_unit` / `integration` は false が skip 側なので、確信が持てない時は true
//
// 出すのは `productUnit` であって `product` ではない。CI の unit test を走らせるかは
// Vercel の build を走らせるかとは別問題で、CI toolchain の変更で前者だけが true になる。
//
// `integration` は CI 4 層再設計（#2269）+ CI ファイル統合（#2483 Phase 1）で
// scripts/ci/check.sh の test モードが「affected な PR だけ Supabase を起動して
// integration/RLS を走らせる」判定に使う。旧 integration.yml の手書き paths と
// INTEGRATION_GLOBS の二重管理（#1815 で見送った理由: gate job 化すると常時起動の
// 課金が増える）は、per-PR 実行そのものを scripts 側の判定に一本化したことで解消した
// （drift の心配がある二重管理自体が無くなった）。
//
// このコマンド自体が落ちた場合は stdout が空になり、GITHUB_OUTPUT に何も書かれない。
// 下流は空文字を `!= 'true'` / `!= 'false'` で受けて実行側に倒すため、やはり fail closed。

export function formatGithubOutput(impact) {
  const docsOnly = impact?.docsOnly === true ? 'true' : 'false';
  const productUnit = impact?.productUnit === false ? 'false' : 'true';
  const webCi = impact?.webCi === false ? 'false' : 'true';
  const integration = impact?.integration === false ? 'false' : 'true';
  const mcpConformance = impact?.mcpConformance === false ? 'false' : 'true';
  return `docs_only=${docsOnly}\nproduct_unit=${productUnit}\nweb_ci=${webCi}\nintegration=${integration}\nmcp_conformance=${mcpConformance}\n`;
}

// ─── Vercel Ignored Build Step（`--vercel <product|web>`）────────────
//
// `apps/{product,web}/vercel.json` の `ignoreCommand` から呼ばれる。build container の
// cwd は Root Directory（`apps/product` / `apps/web`）だが、git は checkout のどこから
// 実行しても repo-root 相対の path を返すため（実測済み）、追加の path 変換は不要。
//
// exit code の意味は Vercel の契約: **exit 1 = build 続行、exit 0 = build を skip**。
// 基準は `VERCEL_GIT_PREVIOUS_SHA`（その project + branch の直前の**成功** deployment
// の SHA。Ignored Build Step 設定時のみ露出）〜 HEAD。merge の親コミットとの diff では
// ない（旧 docs/projects/_archive/ci-monorepo-refactor/overview.md §8「Phase 4 への制約」、
// docs/projects 全廃に伴い #2473 で削除、git 履歴参照。merge 単位
// で判定すると、失敗した release が取りこぼした変更を Vercel 側だけ永久に skip し続ける）。
//
// **fail open を徹底する**（= build 側に倒す）。env 欠落、対象 SHA が checkout の履歴に
// 無い（shallow clone。build container は `git clone --depth=10`）、git 呼び出し失敗、
// resolver が判定不能・想定外の例外 — これらは全て exit 1。exit 0（skip）に倒れるのは
// 「diff が取れて resolveImpact が明確に false を返した」場合だけ。

const VERCEL_PROJECT_KEYS = new Set(['product', 'web']);

const shortSha = (sha) =>
  typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : String(sha);

/**
 * `baseSha`〜`targetSha` 間の変更ファイル一覧。scripts/ci/production-release.mjs の
 * `gitDiffFiles` と同じ規則（`--no-renames` で rename 元も拾う、`-z` で non-ASCII path の
 * エスケープを避ける）。対象 commit が checkout に無ければ git が非 0 で終了し、
 * throw して呼び出し側の fail open 経路へ落ちる。
 */
export function gitDiffFiles(baseSha, targetSha, { cwd = ROOT } = {}) {
  const stdout = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', baseSha, targetSha],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // 失敗は戻り値（throw）で扱う。stderr をそのまま build log へ流すと、
      // fail open の正常な分岐が事故のように見える。
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return stdout.split('\0').filter(Boolean);
}

/**
 * Vercel Ignored Build Step の判定本体。env 読み取りと副作用（stdout / exit code）を
 * 持たない純粋な形にして、CLI からも test からも同じ経路を通す。
 *
 * @param {{
 *   projectKey: string,
 *   prevSha: string | undefined,
 *   vercelEnv?: string | undefined,
 *   targetSha?: string,
 *   cwd?: string,
 *   diffFilesImpl?: typeof gitDiffFiles,
 *   resolveImpactImpl?: typeof resolveImpact,
 * }} params
 * @returns {{ shouldBuild: boolean, reason: string }}
 */
export function resolveVercelIgnore({
  projectKey,
  prevSha,
  vercelEnv,
  targetSha = 'HEAD',
  cwd = ROOT,
  diffFilesImpl = gitDiffFiles,
  resolveImpactImpl = resolveImpact,
}) {
  if (!VERCEL_PROJECT_KEYS.has(projectKey)) {
    return { shouldBuild: true, reason: `unknown Vercel project key "${projectKey}" (fail open)` };
  }

  // **production build（main への merge が作る candidate）は skip しない。**
  // `VERCEL_GIT_PREVIOUS_SHA` は「その project + branch で前回**成功した build**」であり
  // 「live に promote された SHA」ではない。Auto-assign 無効化後は「candidate の build は
  // 成功したが release が smoke / audit で失敗し、未 promote のまま」が正常に起こりうる。
  // その candidate を基準に skip すると、次の merge で production-release.mjs（live SHA
  // 基準で affected 判定）が存在しない candidate を WORST_CASE まで待ち続け、release が
  // 詰まる（PR #1835 Codex P1）。live SHA を ignoreCommand から取るには VERCEL_TOKEN の
  // build env 配布が要り、secrets 方針（automation 専用）に反するため採らない。
  // 削減の主戦場は push 回数の多い preview 側なので、production を常時 build しても
  // 失うものは merge あたり最大 2 build（従来と同じ）だけ。
  if (vercelEnv === 'production') {
    return {
      shouldBuild: true,
      reason: 'production build is never skipped (release gate depends on candidates existing)',
    };
  }

  if (!prevSha) {
    return {
      shouldBuild: true,
      reason:
        'VERCEL_GIT_PREVIOUS_SHA is not set (fail open — first deployment, or Ignored Build Step not active for this project)',
    };
  }

  let files;
  try {
    files = diffFilesImpl(prevSha, targetSha, { cwd });
  } catch (error) {
    return {
      shouldBuild: true,
      reason: `git diff ${shortSha(prevSha)}..${shortSha(targetSha)} failed, likely a shallow clone without the previous SHA (fail open): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // 差分 0 件は「変更が無い」という確定的な答え（production-release.mjs の
  // resolveProjectImpact と同じ扱い）。resolveImpact へ空配列を渡すと「判定不能」として
  // fail closed（全 affected）になってしまうため、ここで先に確定させる。
  if (files.length === 0) {
    return { shouldBuild: false, reason: `no file changes since ${shortSha(prevSha)}` };
  }

  let impact;
  try {
    impact = resolveImpactImpl(files);
  } catch (error) {
    return {
      shouldBuild: true,
      reason: `impact resolver threw (fail open): ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const affected = impact?.[projectKey];
  if (typeof affected !== 'boolean') {
    return {
      shouldBuild: true,
      reason: `resolver returned no verdict for "${projectKey}" (fail open)`,
    };
  }

  if (affected) {
    const trigger = impact.reasons?.[projectKey] ?? impact.unknown?.[0] ?? 'affected';
    return { shouldBuild: true, reason: `${projectKey} affected — ${trigger}` };
  }

  return { shouldBuild: false, reason: `no ${projectKey} impact since ${shortSha(prevSha)}` };
}

// ─── CLI ────────────────────────────────────────────────────────────

async function readStdinLines() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split('\n');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const vercelIndex = args.indexOf('--vercel');

  if (vercelIndex !== -1) {
    const projectKey = args[vercelIndex + 1];
    const { shouldBuild, reason } = resolveVercelIgnore({
      projectKey,
      prevSha: process.env.VERCEL_GIT_PREVIOUS_SHA,
      vercelEnv: process.env.VERCEL_ENV,
    });
    process.stdout.write(
      `[impact] --vercel ${projectKey}: ${shouldBuild ? 'BUILD' : 'SKIP'} — ${reason}\n`,
    );
    process.exitCode = shouldBuild ? 1 : 0;
  } else {
    const useStdin = args.includes('--stdin');
    const summary = args.includes('--summary');
    const githubOutput = args.includes('--github-output');
    const fileArgs = args.filter((a) => !a.startsWith('--'));

    const files = useStdin ? await readStdinLines() : fileArgs;
    const impact = resolveImpact(files);

    if (githubOutput) {
      process.stdout.write(formatGithubOutput(impact));
    } else if (summary) {
      process.stdout.write(formatSummary(impact));
    } else {
      process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
    }
  }
}
