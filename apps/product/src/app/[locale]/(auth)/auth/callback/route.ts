/**
 * Auth Callback Route Handler
 *
 * OAuth認証とメール確認後のコールバック処理
 *
 * @see https://supabase.com/docs/guides/auth/server-side/nextjs
 * @see Issue #531 - Supabase × Vercel × Next.js 認証チェックリスト
 *
 * フロー:
 * 1. ユーザーがOAuth（Google/Apple）でサインイン
 * 2. SupabaseがこのエンドポイントにリダイレクトしてAuthCodeを送信
 * 3. AuthCodeをアクセストークンに交換
 * 4. セッションを確立してダッシュボードへリダイレクト
 */

import { NextResponse } from 'next/server';

import { deliverWelcomeEmailOnce } from '@/features/auth/server/welcome-email';
import { logger } from '@/lib/logger';
import { getSafeRedirectPath } from '@/lib/safe-redirect';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';

/** exchangeCodeForSession は Supabase Auth API 呼び出し 1 回のみ。redirect 前提の同期フローに余裕を見る。 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = getSafeRedirectPath(requestUrl.searchParams.get('next'));

  if (code) {
    const supabase = await createClient();

    // AuthCodeをセッションに交換
    const { data, error } = await observeAuthOperation('exchange_code_for_session', () =>
      supabase.auth.exchangeCodeForSession(code),
    );

    if (!error) {
      // 初回だけ歓迎メールを送る。2 回目以降は profiles の conditional UPDATE が
      // 0 行になって即戻るので、サインインの体感には効かない。失敗しても throw しない。
      const userId = data.session?.user?.id;
      if (userId) await deliverWelcomeEmailOnce(userId);

      // 成功した場合は元のページまたはデフォルトページへリダイレクト
      return NextResponse.redirect(new URL(next, request.url));
    }

    logger.warn('Auth callback code exchange failed');
    return NextResponse.redirect(new URL('/auth/login?error=auth_callback_error', request.url));
  }

  // コードがない場合はログインページへリダイレクト（理由をユーザーに通知）
  logger.warn('[auth/callback] missing code parameter');
  return NextResponse.redirect(
    new URL('/auth/login?error=auth_callback_missing_code', request.url),
  );
}
