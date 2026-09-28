#!/usr/bin/env node

/**
 * バンドルサイズバジェットチェック
 *
 * .next/diagnostics/route-bundle-stats.json を読み込み、
 * 各ルートの First Load JS (gzip) をバジェットと比較する。
 *
 * Usage:
 *   npx tsx scripts/tasks/check-bundle-budget.ts                  # レポート出力（warn-only）
 *   npx tsx scripts/tasks/check-bundle-budget.ts --fail            # バジェット超過時に exit 1
 *   npx tsx scripts/tasks/check-bundle-budget.ts --output=path.json # JSON結果を保存
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const APP_ROOT = resolve(ROOT, 'apps/product');
const STATS_FILE = resolve(APP_ROOT, '.next/diagnostics/route-bundle-stats.json');

// ---------------------------------------------------------------------------
// バジェット定数
// ---------------------------------------------------------------------------

/** 回帰防止ライン（現状 + 15% バッファ） */
const BUDGETS = {
  // 認証系ルート（/auth/*）: 2026-08-14〜17、/auth/reset-password が本予算(460KB)を
  // 476.5 KB gzip（Vercel production 実測、#2121）で超過し production デプロイが
  // 3 日以上全滅した。原因は NEXT_PUBLIC_SENTRY_DSN が Production にのみスコープされて
  // いるため、preview/ローカル build では Sentry 初期化が dead-code-eliminate され
  // 全 route 一律 -66〜68 KB 軽くなる非対称（preview 実測 409.1 KB）。この非対称自体は
  // 下記 SENTRY_COMPONENT_KB + SUPABASE_CREDENTIAL_COMPONENT_KB で解消済み（#2123, #2163）。本予算は実測値 476.5 KB
  // + 余裕で 500 KB のまま（一時緩和時の値を継続、再引き締めは別途判断）。
  // ResetPasswordForm.tsx の MFAVerifyForm 遅延ロード（同 #2121）は局所的な削減。
  /** 認証系ルート（/auth/*）: production 実測 ~477 KB gzip。#2123 の補正により preview/ローカルも同じ土俵で比較する（#2121, #2123 参照） */
  AUTH_ROUTES_WARN_KB: 500,
  /** アプリ本体ルート: 現状 ~836 KB gzip */
  APP_ROUTES_WARN_KB: 960,
  /** CSS 合計: 現状 ~90 KB gzip */
  CSS_WARN_KB: 95,
} as const;

/**
 * preview/production budget parity（#2123、成分分解・再較正は #2163）。
 *
 * production build は preview/ローカル build より重い。原因は独立した 2 つの成分の
 * 加算で、どちらも preview では欠けている:
 *
 * 1. **Sentry 成分**: `NEXT_PUBLIC_SENTRY_DSN` は Production にのみスコープされている
 *    （意図的、preview のノイズを Sentry へ送らない設計。`apps/product/production-build-gate.mjs`
 *    の `FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV` が preview への実値混入を禁止する）。
 *    `apps/product/instrumentation-client.ts` の Sentry 初期化はこの値でガードされているため、
 *    preview/ローカル build では Sentry client SDK（browserTracingIntegration 等）が
 *    dead-code-elimination で全 route から一律に消える。
 *    対応として instrumentation-client.ts 側を変更する案（dummy DSN 注入・lazy load）は
 *    両方とも見送った: dummy DSN 注入は preview で `Sentry.init()` を実際に呼ぶことになり、
 *    `enabled: false` を渡しても公式ドキュメントが明記する通り「doesn't prevent all overhead」
 *    （fetch/console 等の instrumentation hook は enabled に関わらず動きうる）。lazy load
 *    は同意済みリピーターの hydration 直後〜import 解決までの窓でエラー捕捉が抜ける
 *    リスクがある。どちらも observability の本来目的を bundle 削減と天秤にかける必要が
 *    あるため、ここでは budget check 側の補正で対応する（アプリ実行パスには一切触れない）。
 *
 * 2. **Supabase credential 成分**: Supabase Preview Branch を持つ PR
 *    （`supabase/migrations/**` を含む PR）には Vercel integration が実
 *    `NEXT_PUBLIC_SUPABASE_URL` / 実 JWT 形式 anon key を注入し、他の PR は
 *    `apps/product/next.config.mjs` の短い placeholder
 *    （`https://placeholder.supabase.co` / `placeholder`）のまま build される
 *    （`docs/engineering/infra.md` §環境変数の管理 参照）。実 credential の長い文字列が
 *    ビルドへ inline される分（`lib/supabase/{client,server,middleware}.ts`,
 *    `lib/trpc/{context,server}.ts` 等、複数箇所から参照される）だけ preview が軽い。
 *
 * #2123 時点ではこの 2 成分を「production − placeholder preview」の一括差分（67 KB）
 * として較正していたため、実 credential preview（Supabase Preview Branch 付き PR）では
 * 既に含まれる credential 分と一括差分が二重計上になり、偽陽性の budget 超過を招いた
 * （#2159 で発見）。#2163 で 2 成分を独立変数として個別に実測し直した:
 *
 * - **Sentry 成分の実測**（2026-08-18、PR #2159。credential を定数に保つため、同一 PR の
 *   直前 commit の実 credential preview build と、その merge commit の production build を
 *   比較する — どちらも実 credential ありで揃うため、差分は Sentry 成分のみに帰属する）:
 *   production `/[locale]/auth/reset-password` raw 476.0 KB
 *   （merge commit `b7ea3572`, https://vercel.com/dayopt/product/4MfSkJGmu2RK1u6rZFgQRr9GFoe7）
 *   − 実 credential preview 同 route raw 435.4 KB
 *   （直前 commit `9d1ec97b`, https://vercel.com/dayopt/product/GzurMBo7wk5mS5s5xsjxLf6R62oo、
 *   502.4 KB 報告値から旧 67 KB 補正を除いた raw）
 *   = 40.6 KB → 41 KB に丸め
 * - **Supabase credential 成分の実測**（同じく 2026-08-18、PR #2159。Sentry 不在を定数に
 *   保つため、実 credential preview と placeholder preview はどちらも Sentry 補正無しの
 *   preview build 同士を比較する）:
 *   実 credential preview 報告値 502.4 KB − placeholder preview 報告値 475.5 KB
 *   （同日の他 PR preview、どちらも旧 67 KB 補正込みの報告値のため差分を取ると補正分は
 *   キャンセルされ credential 成分だけが残る）= 26.9 KB → 27 KB に丸め
 *
 * 2026-08-20 に再実測した合計（production `/[locale]/auth/reset-password` raw 475.9 KB
 * − 同日 placeholder preview raw 408.5 KB = 67.4 KB）が 2 成分の和（41 + 27 = 68 KB）と
 * 近い値で安定していることを確認済み（±1 KB は丸め誤差）。
 *
 * 再較正手順: `supabase/migrations/**` を含む PR を用意し、(a) その PR の Vercel product
 * preview デプロイのビルドログから `/[locale]/auth/reset-password` の raw gzip を読む
 * （`SUPABASE_CREDENTIAL_COMPONENT_KB` 込みの報告値からこの定数を引く）、(b) 同じ PR を
 * merge した後の production デプロイのビルドログから同 route の raw gzip を読む、
 * (c) production − preview で SENTRY_COMPONENT_KB を再計算する。
 * `SUPABASE_CREDENTIAL_COMPONENT_KB` は、同日の別 PR の placeholder preview 報告値と
 * 実 credential preview 報告値の差分（どちらも同じ Sentry 補正込みなので差分でキャンセル
 * される）から再計算する。
 */
const SENTRY_COMPONENT_KB = 41; // #2163 実測（2026-08-18、PR #2159、credential 一定下の production - real-cred preview）
const SUPABASE_CREDENTIAL_COMPONENT_KB = 27; // #2163 実測（2026-08-18、PR #2159、Sentry 不在下の real-cred - placeholder preview）
const IS_PRODUCTION_BUILD = process.env.VERCEL_ENV === 'production';
const PLACEHOLDER_SUPABASE_URL = 'https://placeholder.supabase.co'; // next.config.mjs と同じ値

/**
 * preview/local build に実 Supabase URL（`next.config.mjs` の placeholder 以外）が
 * 埋め込まれているかを判定する。`NEXT_PUBLIC_SUPABASE_URL` を直接読まず引数で受けるのは、
 * env mock 無しで単体テストできるようにするため。
 */
export function hasRealSupabaseCredentials(supabaseUrl: string | undefined): boolean {
  return (
    typeof supabaseUrl === 'string' &&
    supabaseUrl.length > 0 &&
    supabaseUrl !== PLACEHOLDER_SUPABASE_URL
  );
}

/**
 * preview/local build に適用する補正値（KB）。production build には適用しない
 * （呼び出し側で `IS_PRODUCTION_BUILD` を先に見て 0 に倒す）。
 *
 * 実 credential preview は credential 成分が既にビルドへ inline 済みのため Sentry 成分
 * のみを加算する。placeholder preview は両成分とも欠けているため両方を加算する。
 * 固定Integrationはinstrumentationの初期化コードを含むのでSentry成分を加算しない。
 */
export function resolvePreviewCompensationKB(
  supabaseUrl: string | undefined,
  publicDayoptEnvironment?: string,
): number {
  // Match instrumentation-client.ts's compile-time initialization gate. Fixed
  // Integration includes Sentry even on Vercel Preview, so adding its measured
  // component again would double-count it. The build gate validates the binding.
  const sentryCompensationKB = publicDayoptEnvironment === 'integration' ? 0 : SENTRY_COMPONENT_KB;
  const credentialCompensationKB = hasRealSupabaseCredentials(supabaseUrl)
    ? 0
    : SUPABASE_CREDENTIAL_COMPONENT_KB;
  return sentryCompensationKB + credentialCompensationKB;
}

/** デザインシステム目標値（段階的に達成） */
const TARGETS = {
  FIRST_LOAD_JS_KB: 100,
  CSS_KB: 30,
} as const;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

interface RouteBundleStat {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths: string[];
}

interface RouteResult {
  route: string;
  rawKB: number;
  gzipKB: number;
  budgetKB: number;
  status: 'pass' | 'warn' | 'over';
}

interface BudgetResult {
  timestamp: string;
  routes: RouteResult[];
  css: {
    gzipKB: number;
    budgetKB: number;
    status: 'pass' | 'warn' | 'over';
  };
  summary: {
    totalRoutes: number;
    passCount: number;
    warnCount: number;
    overCount: number;
    loginGzipKB: number;
    smallestGzipKB: number;
    largestGzipKB: number;
  };
}

// ---------------------------------------------------------------------------
// CLI引数パース
// ---------------------------------------------------------------------------

const failOnBudget = process.argv.includes('--fail');
const outputArg = process.argv.find((a) => a.startsWith('--output='));
const outputPath = outputArg ? resolve(APP_ROOT, outputArg.replace('--output=', '')) : null;

// ---------------------------------------------------------------------------
// gzip計算
// ---------------------------------------------------------------------------

function computeGzipSize(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const result = execSync(`gzip -c "${filePath}" | wc -c`, {
      cwd: APP_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

function computeRouteGzipBytes(chunkPaths: string[]): number {
  let total = 0;
  for (const chunk of chunkPaths) {
    const fullPath = resolve(APP_ROOT, chunk);
    total += computeGzipSize(fullPath);
  }
  return total;
}

function computeCssGzipKB(): number {
  try {
    const result = execSync('gzip -c .next/static/chunks/*.css | wc -c', {
      cwd: APP_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return Math.round((parseInt(result.trim(), 10) / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// ルート分類
// ---------------------------------------------------------------------------

function isAuthRoute(route: string): boolean {
  return /\/auth/.test(route);
}

function getBudgetForRoute(route: string): number {
  return isAuthRoute(route) ? BUDGETS.AUTH_ROUTES_WARN_KB : BUDGETS.APP_ROUTES_WARN_KB;
}

function getStatus(gzipKB: number, budgetKB: number): 'pass' | 'warn' | 'over' {
  if (gzipKB <= budgetKB) return 'pass';
  return 'over';
}

// ---------------------------------------------------------------------------
// Markdownレポート
// ---------------------------------------------------------------------------

function formatMarkdown(result: BudgetResult): string {
  const lines: string[] = [];

  lines.push('## Bundle Size Budget Report');
  lines.push('');

  // サマリー
  const { summary } = result;
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Login page (gzip) | ${summary.loginGzipKB} KB |`);
  lines.push(`| Smallest route (gzip) | ${summary.smallestGzipKB} KB |`);
  lines.push(`| Largest route (gzip) | ${summary.largestGzipKB} KB |`);
  lines.push(`| CSS total (gzip) | ${result.css.gzipKB} KB |`);
  lines.push(`| Routes over budget | ${summary.overCount} / ${summary.totalRoutes} |`);
  lines.push('');

  // 目標値との差
  lines.push('### Design System Targets');
  lines.push(`| Target | Budget | Current | Gap |`);
  lines.push(`|--------|--------|---------|-----|`);
  lines.push(
    `| First Load JS | ${TARGETS.FIRST_LOAD_JS_KB} KB | ${summary.loginGzipKB} KB | ${summary.loginGzipKB > TARGETS.FIRST_LOAD_JS_KB ? `+${summary.loginGzipKB - TARGETS.FIRST_LOAD_JS_KB} KB` : 'OK'} |`,
  );
  lines.push(
    `| CSS | ${TARGETS.CSS_KB} KB | ${result.css.gzipKB} KB | ${result.css.gzipKB > TARGETS.CSS_KB ? `+${(result.css.gzipKB - TARGETS.CSS_KB).toFixed(1)} KB` : 'OK'} |`,
  );
  lines.push('');

  // ルート別
  lines.push('### Per-Route Breakdown');
  lines.push('');
  lines.push(`| Status | Route | Raw | Gzip | Budget |`);
  lines.push(`|--------|-------|-----|------|--------|`);

  const sorted = [...result.routes].sort((a, b) => b.gzipKB - a.gzipKB);
  for (const r of sorted) {
    const icon = r.status === 'pass' ? 'OK' : 'OVER';
    lines.push(`| ${icon} | \`${r.route}\` | ${r.rawKB} KB | ${r.gzipKB} KB | ${r.budgetKB} KB |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

function main(): void {
  if (!existsSync(STATS_FILE)) {
    console.error(`Error: ${STATS_FILE} not found. Run "npm run build" first.`);
    process.exit(1);
  }

  const stats = JSON.parse(readFileSync(STATS_FILE, 'utf8')) as RouteBundleStat[];

  console.log(`Checking bundle budgets for ${stats.length} routes...\n`);
  const previewCompensationKB = IS_PRODUCTION_BUILD
    ? 0
    : resolvePreviewCompensationKB(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
      );
  if (!IS_PRODUCTION_BUILD) {
    const suffix =
      process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration'
        ? '（Integration の Sentry 成分は計測済み、#2910）'
        : hasRealSupabaseCredentials(process.env.NEXT_PUBLIC_SUPABASE_URL)
          ? '（実 Supabase credential 検出、Sentry 成分のみ加算、#2163）'
          : '（Sentry 成分 + Supabase credential 成分を加算、#2163）';
    console.log(
      `  (preview/local build: +${previewCompensationKB} KB compensation applied per route, #2123${suffix})\n`,
    );
  }

  const routes: RouteResult[] = [];

  for (const stat of stats) {
    const rawKB = Math.round(stat.firstLoadUncompressedJsBytes / 1024);
    const gzipBytes = computeRouteGzipBytes(stat.firstLoadChunkPaths);
    const measuredGzipKB = Math.round((gzipBytes / 1024) * 10) / 10;
    const gzipKB = IS_PRODUCTION_BUILD
      ? measuredGzipKB
      : Math.round((measuredGzipKB + previewCompensationKB) * 10) / 10;
    const budgetKB = getBudgetForRoute(stat.route);
    const status = getStatus(gzipKB, budgetKB);

    routes.push({ route: stat.route, rawKB, gzipKB, budgetKB, status });

    const icon = status === 'pass' ? 'OK' : 'OVER';
    console.log(`  ${icon}  ${gzipKB} KB / ${budgetKB} KB  ${stat.route}`);
  }

  // CSS
  const cssGzipKB = computeCssGzipKB();
  const cssStatus = getStatus(cssGzipKB, BUDGETS.CSS_WARN_KB);
  console.log(`\n  CSS: ${cssGzipKB} KB / ${BUDGETS.CSS_WARN_KB} KB  (${cssStatus})`);

  // サマリー計算
  const loginRoute = routes.find((r) => r.route.includes('/login'));
  const passCount = routes.filter((r) => r.status === 'pass').length;
  const overCount = routes.filter((r) => r.status === 'over').length;
  const gzipValues = routes.map((r) => r.gzipKB);

  const result: BudgetResult = {
    timestamp: new Date().toISOString(),
    routes,
    css: {
      gzipKB: cssGzipKB,
      budgetKB: BUDGETS.CSS_WARN_KB,
      status: cssStatus,
    },
    summary: {
      totalRoutes: routes.length,
      passCount,
      warnCount: 0,
      overCount,
      loginGzipKB: loginRoute?.gzipKB ?? 0,
      smallestGzipKB: Math.min(...gzipValues),
      largestGzipKB: Math.max(...gzipValues),
    },
  };

  // Markdown出力
  const markdown = formatMarkdown(result);
  console.log(`\n${markdown}`);

  // JSON保存
  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`Result saved to: ${outputPath}`);
  }

  // 終了コード
  // CSS も route と同じく --fail の対象にする。CSS 予算はかつて size-limit が
  // 別途強制していたが、あれは @size-limit/preset-app 経由で headless Chrome を
  // 起動する（CSS に実行時間の測定は無意味で、Vercel の build 環境で browser が
  // 使える保証も無い）。強制はここへ寄せた上で、size-limit / @size-limit/preset-app
  // 自体を撤去した（#2066、extract-zip HIGH の依存経路①を断つため。CI 未使用で
  // 強制も既にここへ移設済みだったため実害なし）。

  if (failOnBudget && (overCount > 0 || cssStatus === 'over')) {
    if (overCount > 0) {
      console.log(`\nBudget exceeded: ${overCount} route(s) over budget.`);
    }
    if (cssStatus === 'over') {
      console.log(`\nBudget exceeded: CSS ${cssGzipKB} KB > ${BUDGETS.CSS_WARN_KB} KB.`);
    }
    process.exit(1);
  }
}

// テストから純粋関数だけを import した時に CLI 本体を実行しないためのガード
// （STATS_FILE が無い test 環境で process.exit(1) が走ると test runner ごと落ちる）。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
