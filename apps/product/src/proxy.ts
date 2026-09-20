import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { dayoptDomains } from '@dayopt/config';

import { OG_IMAGE_PATH } from '@/lib/app-url';
import {
  isAuthPathAllowedWhileAuthenticated,
  isAuthProductPath,
  isProtectedProductPath,
  isPublicProductPath,
  isPublicRewritePath,
} from '@/lib/auth/domain';
import { isValidCalendarViewToken } from '@/lib/calendar-view-tokens';
import { logger } from '@/lib/logger';
import {
  isOAuthRequestHostAllowed,
  isOAuthSurfacePath,
  resolveOAuthEnvironmentConfig,
} from '@/lib/oauth-server/identity';
import { captureUnexpectedError } from '@/lib/sentry';
import { updateSession } from '@/lib/supabase/middleware';
import { applySessionContinuity, type SessionContinuity } from '@/lib/supabase/session-continuity';
import { resolveMfaAssurance } from '@/lib/trpc/session-auth-context';
import { routing } from '@dayopt/i18n/routing';

// next-intlのミドルウェアを作成
const intlMiddleware = createMiddleware(routing);

const MCP_HOST = dayoptDomains.mcp;
const KNOWN_OAUTH_HOSTS = new Set<string>([dayoptDomains.product, dayoptDomains.mcp]);
const CSP_HEADER = 'Content-Security-Policy';
const CSP_REPORT_URI = '/api/csp-report';

function getSentryIngestOrigin(dsn: string | undefined): string | undefined {
  if (!dsn) return undefined;

  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== 'https:' || !parsed.username) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

const SENTRY_INGEST_ORIGIN = getSentryIngestOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN);

/** ローカル Supabase の loopback hostname。service-role-target-guard.ts の LOCAL_HOSTNAMES と同じ集合。 */
const LOCAL_SUPABASE_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

function getLocalSupabaseOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    return LOCAL_SUPABASE_HOSTNAMES.has(parsed.hostname) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * NEXT_PUBLIC_SUPABASE_URL が実際に loopback を指す時だけ connect-src へ足す。
 * NODE_ENV ではなく実際に設定された URL から判定するため、`next build && next start`
 * （NODE_ENV は常に production）でローカル Supabase を使う E2E でも block されない。
 * hosted Supabase を指す実デプロイでは常に undefined になり、`*.supabase.co` の
 * wildcard だけで足りるため connect-src は変わらない。
 */
const LOCAL_SUPABASE_ORIGIN = getLocalSupabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);

function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildContentSecurityPolicy(nonce: string): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const connectSrc = [
    "'self'",
    'https://*.supabase.co',
    'https://vercel.live',
    'wss://*.supabase.co',
    'https://vitals.vercel-insights.com',
    'https://api.pwnedpasswords.com',
    'https://challenges.cloudflare.com',
    ...(SENTRY_INGEST_ORIGIN ? [SENTRY_INGEST_ORIGIN] : []),
    ...(LOCAL_SUPABASE_ORIGIN ? [LOCAL_SUPABASE_ORIGIN] : []),
  ].join(' ');

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
    'https://vercel.live',
    'https://va.vercel-scripts.com',
    'https://www.google.com',
    'https://www.gstatic.com',
    'https://challenges.cloudflare.com',
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-src 'self' https://vercel.live https://www.google.com https://recaptcha.google.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
    `report-uri ${CSP_REPORT_URI}`,
  ].join('; ');
}

function prepareCspRequest(request: NextRequest): string {
  const nonce = createCspNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  request.headers.set('x-nonce', nonce);
  request.headers.set(CSP_HEADER, contentSecurityPolicy);
  return contentSecurityPolicy;
}

function applyCsp(response: NextResponse, contentSecurityPolicy: string): NextResponse {
  response.headers.set(CSP_HEADER, contentSecurityPolicy);
  return response;
}

function nextWithCsp(request: NextRequest, contentSecurityPolicy: string): NextResponse {
  return applyCsp(NextResponse.next({ request }), contentSecurityPolicy);
}

function redirectWithCsp(url: URL, contentSecurityPolicy: string): NextResponse {
  return applyCsp(NextResponse.redirect(url), contentSecurityPolicy);
}

/**
 * next-intl が rewrite 先を決める時と同じ正規化を pathname へ適用する。
 *
 * next-intl 4.13.2 は `decodeURI`（`middleware.js:16`）**の後に**
 * `sanitizePathname`（`middleware.js:25` → `utils.js:187`）を通した値で
 * rewrite 先を決める。decode だけを揃えても sanitize の 3 段が残るため、
 * `/%09calendar`（TAB）・`/%0A/calendar`（LF）・`//calendar`（連続スラッシュ）は
 * 判定側で別物のままになり、同じバイパスが 1 文字違いで成立する。
 * **decodeURI + sanitize 相当を同じ順で 1 回ずつ**通すのが要件で、
 * 多重 decode すると rewrite 側と再びずれる（`%2F` を decode しない挙動も
 * rewrite 側と揃う）。
 *
 * 不正な escape で `decodeURI` は URIError を投げるため、その場合は null を
 * 返して呼び出し側に fail closed の分岐を強制する。
 *
 * next-intl を upgrade する時は `utils.js` の `sanitizePathname` がここと
 * 一致しているか確認する（drift は proxy.canonicalization.test.ts が実物の
 * next-intl を通して検出する）。
 */
function canonicalizePathname(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURI(pathname);
  } catch {
    return null;
  }
  // next-intl の sanitizePathname（utils.js:187）と同じ置換を同じ順で行う。
  // U+0009 / U+000A / U+000D は WHATWG URL parser が黙って落とすため、
  // 除去しないと segment 区切り位置の TAB が `//host` へ潰れる。
  return decoded
    .replace(/\\/g, '%5C')
    .replace(/[\t\n\r]/g, '')
    .replace(/\/+/g, '/');
}

function notFoundWithCsp(contentSecurityPolicy: string): NextResponse {
  return applyCsp(
    new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } }),
    contentSecurityPolicy,
  );
}

// 言語プレフィックスを除いたパスを取得
// as-needed設定: デフォルト言語(en)はプレフィックスなし
function getPathWithoutLocale(pathname: string): string {
  // 非デフォルトロケール(ja)のみプレフィックスあり
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue; // デフォルトはスキップ
    if (pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(locale.length + 1);
    }
    if (pathname === `/${locale}`) {
      return '/';
    }
  }
  // デフォルト言語またはプレフィックスなしの場合はそのまま返す
  return pathname;
}

// 現在の言語を取得
// as-needed設定: プレフィックスなし = デフォルト言語(en)
function getCurrentLocale(pathname: string): string {
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue; // デフォルトはスキップ
    if (pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`) {
      return locale;
    }
  }
  return routing.defaultLocale;
}

// ロケールプレフィックス付きパスを生成
// as-needed設定: デフォルト言語(en)はプレフィックスなし
export function getLocalizedPath(path: string, locale: string): string {
  if (locale === routing.defaultLocale) {
    // デフォルト言語はプレフィックスなし
    return path;
  }
  // 非デフォルト言語はプレフィックス付き
  return `/${locale}${path}`;
}

// workspace の旧 URL（/day, /week, /2day〜/7day）。/calendar への統一後も
// workspace-shell-restructure Step 6（旧route削除）まで redirect の入力として残す。
const LEGACY_WORKSPACE_VIEW_PATTERN = /^\/(day|week|[2-7]day)$/;

interface LegacyWorkspaceRedirect {
  pathname: '/calendar' | '/report';
  search: string;
}

/**
 * 旧 URL（/day, /week, /Nday、`?panel=` 付き含む）を新 URL契約（/calendar, /report）へ写す。
 *
 * `?panel=review|diff|analytics` は `/report` へ、それ以外は `/calendar?view=` へ。
 * 既存クエリは素通しし、この関数が明示的に扱うキー（panel / reviewTagId / view / range）
 * だけを置換・削除する（旧 docs/projects/_archive/workspace-shell-restructure/overview.md
 * §4-4、docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
 *
 * `/review`（削除済み旧route）はこの関数の対象外（張らない。§4-4）。
 */
function resolveLegacyWorkspaceRedirect(
  pathWithoutLocale: string,
  searchParams: URLSearchParams,
): LegacyWorkspaceRedirect | null {
  const match = LEGACY_WORKSPACE_VIEW_PATTERN.exec(pathWithoutLocale);
  if (!match) return null;

  const legacyView = match[1]!;
  const panel = searchParams.get('panel');
  const params = new URLSearchParams(searchParams);

  if (panel === 'review' || panel === 'diff' || panel === 'analytics') {
    params.delete('panel');
    params.delete('reviewTagId');
    // レポートは週 / 月 / 年の 3 粒度しか持たない（#2575）。旧 `/day?panel=` も週へ寄せる。
    params.set('range', 'week');
    return { pathname: '/report', search: params.toString() };
  }

  params.set('view', legacyView);
  return { pathname: '/calendar', search: params.toString() };
}

/**
 * `/calendar?view=` が範囲外の場合、page.tsx の notFound() を待たず edge で 404 を返す。
 *
 * page 側の notFound()（searchParams 依存）は静的シェルの prerender と競合し、
 * status code に反映されない（`x-nextjs-prerender: 1` で 200 が返る、2026-08-19 実測。
 * `dynamic = 'force-dynamic'` / `connection()` のいずれでも解消せず、page 内では
 * 構造的に解決不能と判断）。redirect 群と同じ edge 層で完結させることで、
 * 「範囲外 view は 404」の契約を守る。
 *
 * `getAll` を使う: `?view=week&view=8day` のように同一キーが重複すると
 * `URLSearchParams.get` は先頭値しか見ず、後続の不正値を素通しさせてしまう。
 */
function resolveCalendarViewNotFound(
  pathWithoutLocale: string,
  searchParams: URLSearchParams,
): boolean {
  if (pathWithoutLocale !== '/calendar') return false;
  const values = searchParams.getAll('view');
  if (values.length === 0) return false;
  return values.some((value) => !isValidCalendarViewToken(value));
}

export async function proxy(request: NextRequest) {
  const hostname = request.nextUrl.hostname;

  // 認可判定より前に pathname を正規化する。
  //
  // `request.nextUrl.pathname` は percent-encoding を保ったまま渡ってくるのに対し、
  // next-intl の middleware は `decodeURI` した値で rewrite 先を決める
  // （4.13.2 `middleware.js:16`、encode 前後が異なれば `:40` で rewrite が出る）。
  // 判定側だけが encode されたままだと `/%63alendar` は
  // `isProtectedProductPath` の `startsWith` に一致せず「保護対象ではない」と
  // 扱われる一方、rewrite で `/calendar` が描画され、未認証の login redirect と
  // aal1 の MFA gate を同時に迂回できる（locale prefix を encode した
  // `/%6a%61/calendar` は getPathWithoutLocale も素通りするため同じ穴になる）。
  // decode だけでは足りず、next-intl が続けて通す sanitize（TAB / LF / CR の
  // 除去と連続スラッシュの畳み込み）まで揃えないと `/%09calendar` や
  // `//calendar` が同じ穴として残る。
  // **rewrite 先を決めるのと同じ正規化を通した値だけで判定する**のが唯一の
  // 防ぎ方で、判定関数を個別に直しても encode の入り口が残る。
  const rawPathname = request.nextUrl.pathname;
  const pathname = canonicalizePathname(rawPathname);
  if (pathname === null) {
    // decodeURI が URIError を投げる pathname は Next 側でも実ルートへ解決されない。
    // 判定を続けず fail closed で落とす。
    return notFoundWithCsp(prepareCspRequest(request));
  }

  const oauthHostBoundaryResponse = enforceOAuthHostBoundary(
    hostname,
    getPathWithoutLocale(pathname),
  );
  if (oauthHostBoundaryResponse) return oauthHostBoundaryResponse;

  const contentSecurityPolicy = prepareCspRequest(request);

  // 静的ファイル、API、_nextファイルはスキップ
  // API routes は middleware 認証をスキップ — 各ルートが自前で認証:
  // - /api/trpc: protectedProcedure で ctx.userId チェック
  // - /api/chat: 内部認証チェック
  // - /api/webhooks: Stripe/Resend署名検証
  // ⚠️ 新規APIルートは必ず自前の認証を実装すること
  //
  // **ここだけは canonical ではなく raw を見る。** この分岐は「Next が rewrite
  // 抜きで何にルーティングするか」の判定で、認可の分類ではない。canonical を
  // 使うと `/settings/general%2Ex` の `%2E` が `.` へ decode されて静的アセット
  // 用の早期 return に落ち、`updateSession`・protected 判定・MFA gate をまとめて
  // 飛ばす（リテラルの `.` は config.matcher の `.*\..*` で middleware 自体が
  // 起動しないため、raw で見る限りこの穴は開かない）。
  if (
    rawPathname.startsWith('/_next') ||
    rawPathname.startsWith('/api') ||
    rawPathname.includes('.') ||
    (hostname === MCP_HOST && rawPathname === '/') ||
    isPublicRewritePath(rawPathname)
  ) {
    return nextWithCsp(request, contentSecurityPolicy);
  }

  // メンテナンス / オフライン / OG 画像は言語処理をスキップ
  //
  // `/opengraph-image` は App Router の metadata file convention（`app/opengraph-image.tsx`）で
  // 配信される root 直下の path。`[locale]` 配下に同名は無いので、next-intl の
  // `localePrefix: 'as-needed'` に渡すと `/en/opengraph-image` へ rewrite されて 404 になる
  // （#2573）。config.matcher でも除外しているが、percent-encode された変種は matcher を
  // すり抜けるため canonical pathname でも同じ扱いにする。
  if (pathname === '/maintenance' || pathname === '/offline' || pathname === OG_IMAGE_PATH) {
    return nextWithCsp(request, contentSecurityPolicy);
  }

  // 言語プレフィックス付きメンテナンスページへのアクセスをリダイレクト
  for (const locale of routing.locales) {
    if (pathname === `/${locale}/maintenance`) {
      return redirectWithCsp(new URL('/maintenance', request.url), contentSecurityPolicy);
    }
  }

  // `user-tz` Cookie からタイムゾーンを読み取り、リクエストヘッダーとして転送
  // → Server Components / prefetch 関数で `headers().get('x-user-timezone')` で利用可能にする
  const userTz = request.cookies.get('user-tz')?.value;
  if (userTz) {
    request.headers.set('x-user-timezone', userTz);
  }

  // メンテナンスモードチェック
  const isMaintenanceMode = process.env.NEXT_PUBLIC_MAINTENANCE_MODE === 'true';
  if (isMaintenanceMode) {
    return redirectWithCsp(new URL('/maintenance', request.url), contentSecurityPolicy);
  }

  // next-intlのミドルウェアを実行（言語検出とリダイレクト）
  const intlResponse = intlMiddleware(request);

  // リダイレクトレスポンスの場合はそのまま返す
  if (intlResponse.status !== 200) {
    return applyCsp(intlResponse, contentSecurityPolicy);
  }

  const currentLocale = getCurrentLocale(pathname);
  const pathWithoutLocale = getPathWithoutLocale(pathname);

  // 旧URL → /calendar・/report への写像。認証状態を問わないので Supabase への
  // 往復（updateSession）より前、パス分類より前で返す（overview.md §4-3）。
  const legacyRedirect = resolveLegacyWorkspaceRedirect(
    pathWithoutLocale,
    request.nextUrl.searchParams,
  );
  if (legacyRedirect) {
    const target = new URL(getLocalizedPath(legacyRedirect.pathname, currentLocale), request.url);
    target.search = legacyRedirect.search;
    return redirectWithCsp(target, contentSecurityPolicy);
  }

  // /calendar?view= の範囲外検証（page.tsx の notFound() が prerender シェルの
  // status に効かないため edge で完結させる。resolveCalendarViewNotFound 参照）。
  // 認証状態を問わないので legacy redirect と同じ位置、auth 判定より前で返す。
  if (resolveCalendarViewNotFound(pathWithoutLocale, request.nextUrl.searchParams)) {
    return notFoundWithCsp(contentSecurityPolicy);
  }

  const isProtectedPath = isProtectedProductPath(pathWithoutLocale);
  const isAuthPath = isAuthProductPath(pathWithoutLocale);
  const isPublicPath = isPublicProductPath(pathWithoutLocale);

  // パフォーマンス最適化: 公開ページでは getUser() をスキップ
  // getUser() は Supabase API への往復が発生するため、認証が必要なパスのみ実行
  if (isPublicPath && !isProtectedPath && !isAuthPath) {
    return applyCsp(intlResponse, contentSecurityPolicy);
  }

  // updateSession() の refresh Cookie / cache headers を、後続で新しく作る
  // NextResponse（redirect / 404 等）へも引き継ぐための持ち回り（#2516）。
  // catch 節でも使うため try の外に置く（updateSession 解決後に別の処理が
  // throw した場合、そこまでに得た継続性は落とさない）。
  let sessionContinuity: SessionContinuity | undefined;
  const withSession = <T extends NextResponse>(res: T): T =>
    sessionContinuity ? applySessionContinuity(res, sessionContinuity) : res;

  try {
    // Supabaseセッションを更新（ユーザー情報も同時取得 - 重複呼び出し防止で高速化）
    const {
      response,
      supabase,
      user,
      sessionContinuity: continuity,
    } = await updateSession(request);
    sessionContinuity = continuity;
    const redirectWithSession = (url: URL) =>
      withSession(redirectWithCsp(url, contentSecurityPolicy));

    // 環境変数で認証をスキップ（開発環境用）
    const skipAuth =
      process.env.SKIP_AUTH_IN_DEV === 'true' && process.env.NODE_ENV === 'development';

    if (skipAuth) {
      // next-intlのヘッダーをコピー
      intlResponse.headers.forEach((value, key) => {
        response.headers.set(key, value);
      });
      return applyCsp(response, contentSecurityPolicy);
    }

    // 未認証でprotectedPathにアクセスした場合
    if (!user && isProtectedPath) {
      const loginUrl = new URL(getLocalizedPath('/auth/login', currentLocale), request.url);
      // OAuth flow 等で query string が必要なため search も含めて redirect 先に保持する
      const search = request.nextUrl.search;
      loginUrl.searchParams.set('redirect', pathWithoutLocale + search);
      return redirectWithSession(loginUrl);
    }

    // 認証済みでauth系のパスにアクセスした場合
    // MFA検証・メールリンク検証・OAuth callback はセッションを持ったまま通す必要がある
    const isMFAVerifyPath = pathWithoutLocale === '/auth/mfa-verify';
    const isAllowedWhileAuthenticated = isAuthPathAllowedWhileAuthenticated(pathWithoutLocale);

    if (user && isAuthPath && !isAllowedWhileAuthenticated) {
      return redirectWithSession(
        new URL(getLocalizedPath('/calendar', currentLocale), request.url),
      );
    }

    // MFA AAL強制（認証済みユーザーのみ）
    // resolveMfaAssurance は procedures.ts の protectedProcedure guard・calendar
    // 接続 Route Handler と共通の判定源（#2047: 3箇所で判定源が食い違わないよう統一）。
    if (user && isProtectedPath && !isMFAVerifyPath) {
      const mfaAssurance = await resolveMfaAssurance(supabase, 'proxy');
      if (mfaAssurance.lookupFailed) {
        // #2144: /auth/login は認証済みだと /week へ弾かれ、/week は protected path
        // なので MFA gate を再度通る。lookupFailed が続く限り無限ループになるため、
        // authPathsAllowedWhileAuthenticated に登録済みの専用ページへ送る。
        logger.warn('MFA assurance lookup failed; redirecting to session error page');
        return redirectWithSession(
          new URL(getLocalizedPath('/auth/session-error', currentLocale), request.url),
        );
      }
      if (mfaAssurance.currentLevel === 'aal1' && mfaAssurance.nextLevel === 'aal2') {
        // MFA有効だがまだ検証していない → mfa-verifyへ強制リダイレクト
        return redirectWithSession(
          new URL(getLocalizedPath('/auth/mfa-verify', currentLocale), request.url),
        );
      }
    }

    // next-intlのヘッダーをコピー
    intlResponse.headers.forEach((value, key) => {
      response.headers.set(key, value);
    });

    return applyCsp(response, contentSecurityPolicy);
  } catch (error) {
    const original =
      error instanceof Error ? error : new Error('Unexpected proxy failure', { cause: error });
    captureUnexpectedError(original, {
      feature: 'auth',
      operation: 'proxy_request',
      source: 'next_proxy',
    });
    logger.error('Proxy request failed');
    // #2144: session-error ページ自身へのリクエストで updateSession() が
    // (env misconfiguration 等で) persistent に throw すると、ここでまた
    // session-error への redirect を返してしまい自己ループになる。この path
    // 自体は認証を要求しない静的ページなので、redirect せずそのまま次へ流す。
    if (pathWithoutLocale === '/auth/session-error') {
      return withSession(nextWithCsp(request, contentSecurityPolicy));
    }
    // lookupFailed分岐と同じ理由で、/auth/login ではなく認証済みでも
    // 弾かれない session-error ページへ送る（同型の無限ループを避ける）。
    return withSession(
      redirectWithCsp(
        new URL(getLocalizedPath('/auth/session-error', currentLocale), request.url),
        contentSecurityPolicy,
      ),
    );
  }
}

/**
 * OAuth / MCP surface を、この deployment が所有する host だけへ閉じる。
 *
 * identity が壊れている時は OAuth surface と既知 OAuth host だけを 503 にし、
 * 通常のアプリ画面には影響させない（MCP config の誤りで全ページを落とさない）。
 */
function enforceOAuthHostBoundary(hostname: string, pathname: string): NextResponse | null {
  let identity;
  try {
    identity = resolveOAuthEnvironmentConfig({
      mcpOAuthEnvironment: process.env.MCP_OAUTH_ENVIRONMENT,
      authorizationServerUri: process.env.OAUTH_AUTHORIZATION_SERVER_URI,
      resourceUri: process.env.MCP_CANONICAL_RESOURCE_URI,
      vercelEnvironment: process.env.VERCEL_ENV,
      vercelTargetEnvironment: process.env.VERCEL_TARGET_ENV,
      vercelBranchUrl: process.env.VERCEL_BRANCH_URL,
      vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
      mcpOAuthPreviewBranch: process.env.MCP_OAUTH_PREVIEW_BRANCH,
    });
  } catch {
    if (!isOAuthSurfacePath(pathname) && !KNOWN_OAUTH_HOSTS.has(hostname)) return null;
    logger.error('OAuth deployment identity is invalid');
    return NextResponse.json(
      { error: 'service_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (
    isOAuthRequestHostAllowed({
      identity,
      hostname,
      pathname,
      allowLocalDevelopment: process.env.NODE_ENV === 'development' && !process.env.VERCEL_ENV,
    })
  ) {
    return null;
  }

  return NextResponse.json(
    { error: 'not_found' },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

export const config = {
  matcher: [
    '/api/mcp/:path*',
    '/api/oauth/token/:path*',
    '/.well-known/:path*',
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc)
     * - opengraph-image (metadata file convention。拡張子が無いので `.*\\..*` に
     *   引っかからず、除外しないと next-intl が `/en/opengraph-image` へ rewrite して
     *   404 になる。#2573)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*|robots.txt|sitemap.xml|opengraph-image).*)',
  ],
};
