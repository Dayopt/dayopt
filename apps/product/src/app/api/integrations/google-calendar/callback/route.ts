import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import {
  clearConnectFlowCookie,
  connectFlowCookieName,
  isSecureRequest,
  normalizeLocale,
  parseConnectFlowCookie,
} from '@/features/external-calendar/server/connect-flow';
import {
  CALENDAR_CONNECTION_DB_TIMEOUT_MS,
  CalendarConnectionSaveError,
  claimCalendarOAuthAttempt,
  getReconnectTarget,
  reconnectConnection,
  revokeOrphanedGrant,
  saveConnection,
} from '@/features/external-calendar/server/connection-service';
import {
  exchangeAuthorizationCode,
  GoogleOAuthError,
  hasRequiredCalendarScopes,
  isGoogleCalendarConfigured,
  parseGrantedScopes,
  parseIdToken,
  resolveRedirectUri,
  TOKEN_REQUEST_TIMEOUT_MS,
} from '@/features/external-calendar/server/google-oauth';
import { entitlementKeys } from '@dayopt/billing';

import { checkEntitlementForUser } from '@/lib/billing/enforcement';
import { logger } from '@/lib/logger';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { calendarConnectRateLimit } from '@/lib/rate-limit/upstash';
import { getSafeRedirectPath } from '@/lib/safe-redirect';
import { captureUnexpectedError } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';
import { resolveMfaAssurance } from '@/lib/trpc/session-auth-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * #1990 の予算検査により「code 消費後に kill される」経路は塞いだ。
 * OAuth attempt claim を追加したため、code を消費する前に claim・token 交換・fenced save
 * の timeout 合計（`PRE_CLAIM_BUDGET_MS = 45_000`）を確保する。
 *
 * `TIME_BUDGET_MS(80s) - PRE_CLAIM_BUDGET_MS(45s) = 35s` が code 消費前フェーズ
 * （getUser / MFA / rate limit / write fence / Pro 判定 / reconnect target の直列ホップ）
 * の予算になる。遅延が大きい場合は、Google code を消費しないまま `budget_exhausted` を返す。
 * maxDuration=90 により、消費前フェーズに 35s と hard kill margin 10s を残す。
 */
export const maxDuration = 90;

/** maxDuration に対する安全マージン。cron（`TIME_BUDGET_MS`）と同じ導出。 */
const TIME_BUDGET_MS = 80_000;

/**
 * code 消費の危険窓（#1990）。
 *
 * 「危険」は token 交換（`exchangeAuthorizationCode`）の呼び出しを**始めた**時点から始まる —
 * Google が request を受理した後に応答待ちの途中で kill されると、こちらからは成否が
 * 分からないまま code だけ消費済みになりうるため、交換呼び出し自体の worst case
 * （`TOKEN_REQUEST_TIMEOUT_MS`）も危険窓に含める（交換が成功で返ってきてから初めて
 * 危険が始まる、という早合点をしない）。
 *
 * OAuth attempt claim を始めてから connection save までの worst case を基準にする。
 * claim と save は各 1 回の DB 往復、code 交換は Google token endpoint 1 回。
 * `TOKEN_REQUEST_TIMEOUT_MS` / `CALENDAR_CONNECTION_DB_TIMEOUT_MS` から導出し、数値を
 * 二重管理しない。
 *
 * #2072 で追加した `revokeOrphanedGrant`（`scope_not_granted` / `account_mismatch` の
 * 失敗パスで best-effort に呼ぶ）はこの定数に**含めない**。
 * `revokeOrphanedGrant` は呼び出し時に渡す `deadlineAt`（= この route の `deadlineAt`）を
 * 自分で見て残予算不足なら revoke 自体を skip する自己完結の gate を持つため、
 * `PRE_CLAIM_BUDGET_MS` の導出にこの分を足す必要は無い。
 */
const POST_CLAIM_BUDGET_MS = TOKEN_REQUEST_TIMEOUT_MS + CALENDAR_CONNECTION_DB_TIMEOUT_MS;
const PRE_CLAIM_BUDGET_MS = CALENDAR_CONNECTION_DB_TIMEOUT_MS + POST_CLAIM_BUDGET_MS;

/**
 * Settings への戻り先。
 *
 * locale-aware な Integrations 設定へ返す。PC / mobile の query 処理は設定ページの
 * Composition Layer が一元管理する。
 */
function settingsRedirect(requestUrl: URL, locale: string, result: string, reason?: string): URL {
  const query = new URLSearchParams({ calendar: result });
  if (reason) query.set('reason', reason);

  const path = getSafeRedirectPath(
    `/${locale}/settings/integrations?${query.toString()}`,
    '/calendar',
  );
  return new URL(path, requestUrl);
}

/** 一定長でない値を timingSafeEqual に渡すと RangeError になるので長さを先に見る。 */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const deadlineAt = Date.now() + TIME_BUDGET_MS;
  const secure = isSecureRequest(requestUrl);
  const cookieValue = request.cookies.get(connectFlowCookieName(secure))?.value;
  const flowState = parseConnectFlowCookie(cookieValue);
  const locale = normalizeLocale(flowState?.locale);

  const fail = (reason: string): NextResponse => {
    const response = NextResponse.redirect(settingsRedirect(requestUrl, locale, 'error', reason));
    clearConnectFlowCookie(response, secure);
    return response;
  };

  if (!isGoogleCalendarConfigured()) {
    logger.warn('[calendar-callback] google calendar integration is not configured');
    return NextResponse.json({ error: 'Integration is not configured' }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.redirect(new URL('/auth/login', requestUrl));
  }

  // cookie は自作できるため start を踏まずに callback を直接叩ける。MFA登録済みでaal2未検証の
  // セッションでは、token交換・DB書き込みより前に止める。
  //
  // lookupFailed はセッション自体のAAL claim(自分のcookie由来)から到達しうるため、
  // captureすると攻撃者が任意回数Sentry quotaを焼ける増幅経路になる（invalid_grantを
  // 下のcatchでcaptureしないのと同じ理由）。captureせずlogger.warnに留める。
  const mfaAssurance = await resolveMfaAssurance(supabase, 'calendar_connect');
  if (mfaAssurance.lookupFailed) {
    logger.warn('[calendar-callback] MFA assurance lookup failed');
    return fail('assurance_lookup_failed');
  }
  if (mfaAssurance.currentLevel === 'aal1' && mfaAssurance.nextLevel === 'aal2') {
    logger.warn('[calendar-callback] MFA verification required');
    return fail('mfa_verification_required');
  }

  // start と同じ理由でここにも要る。cookie が自作できる以上、start を踏まずに callback を
  // 叩き続けられるので、無制限だと Google の token endpoint への往復と Sentry capture が
  // 青天井になる。start と同じ key を消費するので、正常な接続 1 回で 2 消費する。
  if (calendarConnectRateLimit) {
    try {
      const { success } = await calendarConnectRateLimit.limit(`calendar-connect:${user.id}`);
      if (!success) {
        logger.warn('[calendar-callback] rate limit exceeded');
        return fail('rate_limited');
      }
    } catch (error) {
      captureUnexpectedError(
        error instanceof Error ? error : new Error('calendar callback rate limit failed'),
        {
          feature: 'external_calendar',
          operation: 'check_rate_limit',
          route: '/api/integrations/google-calendar/callback',
          source: 'upstash',
        },
      );
      logger.warn('[calendar-callback] rate limit unavailable; continuing');
    }
  }

  // rate limit の後に置く。ここでは既に認証済みの user-scope client（supabase）を
  // 使うが、認証・rate limit より前に置くと未認証/連打リクエストが DB 読取を無制限に
  // 駆動できてしまう（増幅経路）ため、その手前には置かない。Google の authorization
  // code は token 交換（exchangeAuthorizationCode）の時点で消費されるので、ここに
  // 置けば code を使う前という要件も満たす。
  if (await isWriteFenceEnabled(supabase)) {
    logger.warn('[calendar-callback] write fence is enabled; rejecting connection');
    return fail('write_fenced');
  }

  // start と同じ Pro ゲートをここでも通す。cookie は署名しておらず HttpOnly は JS を
  // 止めるだけなので、ユーザー自身は devtools や curl で中身を作れる。state / verifier /
  // userId を全部自分で用意して Google の認可 URL を手で組み立てれば、start を一度も
  // 踏まずにこの経路へ到達できる。start 側の 403 だけでは Free ユーザーを止められない。
  const entitlement = await checkEntitlementForUser(
    supabase,
    user.id,
    entitlementKeys.externalCalendarSync,
  );

  if (entitlement === 'lookup_failed') {
    captureUnexpectedError(new Error('subscription lookup failed'), {
      feature: 'external_calendar',
      operation: 'check_pro_subscription',
      route: '/api/integrations/google-calendar/callback',
    });
    return fail('subscription_check_failed');
  }

  if (entitlement === 'denied') {
    logger.warn('[calendar-callback] pro entitlement is required');
    return fail('pro_required');
  }

  if (!flowState) {
    logger.warn('[calendar-callback] connect flow cookie is missing or malformed');
    return fail('missing_state');
  }

  // start と callback の間にログアウト → 別アカウントでログインされると、他人の Google
  // アカウントが別人の行に紐づく。userId は秘密ではないので単純比較で足りる
  // （timingSafeEqual は攻撃者が長さを操作できるため RangeError の的になる）。
  if (flowState.userId !== user.id) {
    logger.warn('[calendar-callback] session user does not match the user that started the flow');
    return fail('session_mismatch');
  }

  const errorParam = requestUrl.searchParams.get('error');
  if (errorParam) {
    // ユーザーが同意画面で拒否した場合を含む。値はそのままログに出さない。
    logger.info('[calendar-callback] authorization was not granted');
    return fail('access_denied');
  }

  const stateParam = requestUrl.searchParams.get('state');
  if (!stateParam || !safeEquals(stateParam, flowState.state)) {
    logger.warn('[calendar-callback] state mismatch');
    return fail('state_mismatch');
  }

  const code = requestUrl.searchParams.get('code');
  if (!code) {
    return fail('missing_code');
  }

  const redirectUri = resolveRedirectUri(requestUrl);
  if (!redirectUri) {
    logger.warn('[calendar-callback] no redirect URI registered for this host');
    return fail('unsupported_environment');
  }

  // #2156(a): token 交換後の失敗は下の outer catch で拾う。idToken parse 済みになった時点で
  // これを埋め、outer
  // catch は非 undefined なら best-effort で revoke する。try block 内の `const` は
  // catch から参照できないため、hoist して埋める（overview.md §5）。
  let orphanRevokeCandidate: { providerAccountId: string; refreshToken: string } | undefined;

  try {
    // 再接続先を先に確かめる。Google code を消費してから対象なしと分かると、使い直せない
    // code と孤立 grant が残るため、attempt claim / token 交換より前に読む。
    const reconnectTarget = flowState.reconnectConnectionId
      ? await getReconnectTarget(user.id, flowState.reconnectConnectionId)
      : null;
    if (flowState.reconnectConnectionId && !reconnectTarget) {
      return fail('reconnect_target_invalid');
    }

    // code を消費する前に claim・交換・save の各 timeout を確保する（#1990）。ここで諦めれば
    // code は未消費のまま残り、Google の認可からやり直さずに再試行できる。
    if (deadlineAt - Date.now() < PRE_CLAIM_BUDGET_MS) {
      logger.warn('[calendar-callback] insufficient time budget remaining before code exchange');
      return fail('budget_exhausted');
    }

    await claimCalendarOAuthAttempt({
      attemptId: flowState.attemptId,
      userId: user.id,
      state: flowState.state,
      verifier: flowState.verifier,
    });

    // claim RPC が上限まで使った場合は、code 交換を始めず安全に止める。
    if (deadlineAt - Date.now() < POST_CLAIM_BUDGET_MS) {
      logger.warn('[calendar-callback] insufficient time budget after OAuth attempt claim');
      return fail('budget_exhausted');
    }

    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUri,
      codeVerifier: flowState.verifier,
    });

    const grantedScopes = parseGrantedScopes(tokens.scope);
    if (!hasRequiredCalendarScopes(grantedScopes)) {
      // granular consent でカレンダー scope の一部だけ外された場合。active な接続を作ると
      // 同期が毎回 403 になり「接続済みなのに同期されない」状態が残る。
      logger.warn('[calendar-callback] required calendar scopes were not granted');

      // #2072: token 交換は完了しているため、Dayopt 側に接続行が無いままだと孤立 grant に
      // なる。この時点ではメインフローの idToken パースがまだ走っていないため、専用の
      // try/catch で試みる — 失敗（malformed id_token 等）なら revoke せず安全側に倒す。
      // メインフローのエラーハンドリングには影響しない自己完結ブロック。
      if (tokens.refresh_token) {
        try {
          const scopeFailureIdToken = parseIdToken(tokens.id_token);
          await revokeOrphanedGrant({
            providerAccountId: scopeFailureIdToken.sub,
            refreshToken: tokens.refresh_token,
            deadlineAt,
          });
        } catch {
          // id_token が parse できなければ providerAccountId が特定できないため revoke しない。
        }
      }

      return fail('scope_not_granted');
    }

    if (!tokens.refresh_token) {
      // 既存行があっても触らない。失効済み token を保ったまま status を active に戻すと
      // 再認証導線が出なくなる。
      logger.warn('[calendar-callback] token response did not include a refresh token');
      return fail('missing_refresh_token');
    }

    const idToken = parseIdToken(tokens.id_token);
    orphanRevokeCandidate = { providerAccountId: idToken.sub, refreshToken: tokens.refresh_token };

    const connectionInput = {
      attemptId: flowState.attemptId,
      userId: user.id,
      providerAccountId: idToken.sub,
      providerAccountEmail: idToken.email ?? null,
      grantedScopes,
      refreshToken: tokens.refresh_token,
      encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
    };

    if (reconnectTarget && reconnectTarget.providerAccountId !== idToken.sub) {
      await revokeOrphanedGrant({
        providerAccountId: idToken.sub,
        refreshToken: tokens.refresh_token,
        deadlineAt,
      });
      return fail('account_mismatch');
    }

    const saveOutcome = reconnectTarget
      ? await reconnectConnection({ ...connectionInput, connectionId: reconnectTarget.id })
      : await saveConnection(connectionInput);
    if (saveOutcome === 'missing') {
      await revokeOrphanedGrant({
        providerAccountId: idToken.sub,
        refreshToken: tokens.refresh_token,
        deadlineAt,
      });
      return fail('reconnect_target_invalid');
    }
    if (saveOutcome === 'enqueued') {
      // fenced writer は接続を保存せず revoke outbox へ token を移した。二重 revoke はせず、
      // ユーザーへ接続成功を返さない。
      orphanRevokeCandidate = undefined;
      logger.warn('[calendar-callback] calendar connection save was queued for revocation');
      return fail('connection_failed');
    }
    orphanRevokeCandidate = undefined;
  } catch (error) {
    // #2156(a): token 交換後の失敗はここでしか拾えない。token 交換自体が失敗した早期
    // エラー（GoogleOAuthError）では orphanRevokeCandidate は未設定のままなので revoke を skip。
    if (error instanceof CalendarConnectionSaveError && error.commitOutcome === 'unknown') {
      // save RPC の応答が失われた場合、保存済みの credential を revoke する可能性がある。
      // まずは接続状態を壊さないことを優先し、Sentry で調査できる状態に残す。
      orphanRevokeCandidate = undefined;
      logger.warn('[calendar-callback] connection save outcome is unknown; skipping token revoke');
    }
    if (orphanRevokeCandidate) {
      await revokeOrphanedGrant({
        providerAccountId: orphanRevokeCandidate.providerAccountId,
        refreshToken: orphanRevokeCandidate.refreshToken,
        deadlineAt,
      });
    }

    if (error instanceof GoogleOAuthError) {
      logger.warn('[calendar-callback] google oauth exchange failed');

      // 古い / 使用済み code は誰でも投げられるので Sentry には送らない（capture 自体が
      // quota を焼く増幅経路になる）。それ以外は必ず送る — invalid_client や
      // redirect_uri_mismatch、Google の 5xx を巻き込んで抑制すると、全接続が失敗
      // しているのに無通知という状態になる。
      if (error.reason !== 'authorization_expired') {
        // TechnicalErrorContext のキーは allowlist なので、provider の error 種別は
        // errorCode に畳む。HTTP status は message 側（`token exchange rejected: ...`）に残る。
        captureUnexpectedError(error, {
          feature: 'external_calendar',
          operation: 'exchange_authorization_code',
          route: '/api/integrations/google-calendar/callback',
          errorCode: error.providerError ?? error.reason,
          source: 'google_token_endpoint',
        });
      }

      return fail(error.reason);
    }

    captureUnexpectedError(
      error instanceof Error ? error : new Error('calendar connection failed'),
      {
        feature: 'external_calendar',
        operation: 'save_connection',
        route: '/api/integrations/google-calendar/callback',
      },
    );
    logger.error('[calendar-callback] failed to save the calendar connection');
    return fail('connection_failed');
  }

  const response = NextResponse.redirect(settingsRedirect(requestUrl, locale, 'connected'));
  clearConnectFlowCookie(response, secure);
  return response;
}
