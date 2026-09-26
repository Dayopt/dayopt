import { NextResponse, type NextRequest } from 'next/server';

import {
  isSecureRequest,
  normalizeLocale,
  setConnectFlowCookie,
} from '@/features/external-calendar/server/connect-flow';
import {
  beginCalendarOAuthAttempt,
  getReconnectTarget,
} from '@/features/external-calendar/server/connection-service';
import {
  buildAuthorizationUrl,
  generatePkcePair,
  generateState,
  isGoogleCalendarConfigured,
  resolveRedirectUri,
} from '@/features/external-calendar/server/google-oauth';
import { entitlementKeys } from '@dayopt/billing';

import { checkEntitlementForUser } from '@/lib/billing/enforcement';
import { logger } from '@/lib/logger';
import { calendarConnectRateLimit } from '@/lib/rate-limit/upstash';
import { captureUnexpectedError } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';
import { resolveMfaAssurance } from '@/lib/trpc/session-auth-context';
import { getLocalizedPath } from '@/proxy';
import { z } from 'zod';

/** AES-256-GCM に node:crypto が要る。Edge では動かない。 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** auth / MFA / Pro / rate limit / reconnect target / fenced OAuth attempt の直列往復をカバーする。 */
export const maxDuration = 90;

/**
 * Google カレンダー接続の開始。
 *
 * `/api/*` は proxy の認証をスキップする（`src/proxy.ts` の early return）ので、
 * このルートが自前で session を取る。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const secure = isSecureRequest(requestUrl);

  // env が未投入の環境（マージ直後の production を含む）では接続を始めない。
  // ここで止めないと client_id が空のまま Google の invalid_client 画面へ飛ぶ。
  if (!isGoogleCalendarConfigured()) {
    logger.warn('[calendar-connect] google calendar integration is not configured');
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

  // MFA登録済みでaal2未検証のセッションは、認可URLもcookieも発行せず止める。
  // Pro判定やrate limitより前に置くのは、AAL不足を理由に拒否する場合にそれらの
  // 消費・DB読取を発生させないため。
  //
  // lookupFailed はセッション自体のAAL claim(自分のcookie由来)から到達しうるため、
  // capture すると攻撃者が任意回数 Sentry quota を焼ける増幅経路になる
  // （callback route の invalid_grant 抑制と同じ理由）。captureせずlogger.warnに留める。
  const mfaAssurance = await resolveMfaAssurance(supabase, 'calendar_connect');
  if (mfaAssurance.lookupFailed) {
    logger.warn('[calendar-connect] MFA assurance lookup failed');
    return NextResponse.json({ error: 'Failed to verify session' }, { status: 500 });
  }
  if (mfaAssurance.currentLevel === 'aal1' && mfaAssurance.nextLevel === 'aal2') {
    const locale = normalizeLocale(requestUrl.searchParams.get('locale') ?? undefined);
    return NextResponse.redirect(new URL(getLocalizedPath('/auth/mfa-verify', locale), requestUrl));
  }

  const entitlement = await checkEntitlementForUser(
    supabase,
    user.id,
    entitlementKeys.externalCalendarSync,
  );

  if (entitlement === 'lookup_failed') {
    captureUnexpectedError(new Error('subscription lookup failed'), {
      feature: 'external_calendar',
      operation: 'check_pro_subscription',
      route: '/api/integrations/google-calendar/start',
    });
    return NextResponse.json({ error: 'Failed to verify subscription' }, { status: 500 });
  }

  if (entitlement === 'denied') {
    return NextResponse.json({ error: 'Pro plan required' }, { status: 403 });
  }

  // Upstash 未設定なら null、Redis 障害なら throw。どちらでも接続開始は止めない
  // （可用性優先。iCal feed route と同じ判断）。
  if (calendarConnectRateLimit) {
    try {
      const { success } = await calendarConnectRateLimit.limit(`calendar-connect:${user.id}`);
      if (!success) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      }
    } catch (error) {
      captureUnexpectedError(
        error instanceof Error ? error : new Error('calendar connect rate limit failed'),
        {
          feature: 'external_calendar',
          operation: 'check_rate_limit',
          route: '/api/integrations/google-calendar/start',
          source: 'upstash',
        },
      );
      logger.warn('[calendar-connect] rate limit unavailable; continuing');
    }
  }

  // request から URL を組み立て直さず、allowlist の文字列そのものを使う。
  // host は forwarded ヘッダで動かせるため、導出値を Google へ渡すと code を
  // 第三者ホストへ配送させる経路になる。
  const redirectUri = resolveRedirectUri(requestUrl);
  if (!redirectUri) {
    logger.warn('[calendar-connect] no redirect URI registered for this host');
    return NextResponse.json(
      { error: 'Calendar connection is not available in this environment' },
      { status: 400 },
    );
  }

  const reconnectParam = requestUrl.searchParams.get('reconnectConnectionId');
  const reconnectConnectionId = reconnectParam ? z.string().uuid().safeParse(reconnectParam) : null;

  if (reconnectConnectionId && !reconnectConnectionId.success) {
    return NextResponse.json({ error: 'Reconnect target is invalid' }, { status: 400 });
  }

  // 再接続では、選び直すべきアカウントを同意画面に示唆する（`sub` の一致検査は callback 側）。
  let loginHint: string | undefined;

  if (reconnectConnectionId?.success) {
    try {
      const target = await getReconnectTarget(user.id, reconnectConnectionId.data);
      if (!target) {
        return NextResponse.json({ error: 'Reconnect target is invalid' }, { status: 400 });
      }
      loginHint = target.providerAccountEmail ?? undefined;
    } catch (error) {
      captureUnexpectedError(
        error instanceof Error ? error : new Error('failed to load reconnect target'),
        {
          feature: 'external_calendar',
          operation: 'load_reconnect_target',
          route: '/api/integrations/google-calendar/start',
        },
      );
      return NextResponse.json({ error: 'Failed to start reconnection' }, { status: 500 });
    }
  }

  const state = generateState();
  const { verifier, challenge } = generatePkcePair();
  const locale = normalizeLocale(requestUrl.searchParams.get('locale') ?? undefined);
  let attemptId: string;

  try {
    attemptId = await beginCalendarOAuthAttempt({
      userId: user.id,
      state,
      verifier,
    });
  } catch (error) {
    captureUnexpectedError(
      error instanceof Error ? error : new Error('failed to begin calendar OAuth attempt'),
      {
        feature: 'external_calendar',
        operation: 'begin_oauth_attempt',
        route: '/api/integrations/google-calendar/start',
      },
    );
    logger.error('[calendar-connect] failed to begin fenced OAuth attempt');
    return NextResponse.json({ error: 'Failed to start calendar connection' }, { status: 500 });
  }

  const response = NextResponse.redirect(
    buildAuthorizationUrl({
      redirectUri,
      state,
      codeChallenge: challenge,
      ...(loginHint ? { loginHint } : {}),
    }),
  );

  setConnectFlowCookie(
    response,
    {
      state,
      verifier,
      attemptId,
      locale,
      userId: user.id,
      ...(reconnectConnectionId?.success
        ? { reconnectConnectionId: reconnectConnectionId.data }
        : {}),
    },
    secure,
  );

  return response;
}
