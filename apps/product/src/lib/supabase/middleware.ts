/**
 * Supabase Middleware Client
 *
 * Middleware用のSupabaseクライアント - セッショントークンリフレッシュ処理
 *
 * @see https://supabase.com/docs/guides/auth/server-side/creating-a-client
 * @see Issue #531 - Supabase × Vercel × Next.js 認証チェックリスト
 *
 * 使用箇所:
 * - middleware.ts でのセッショントークンリフレッシュ
 *
 * 使用例:
 * ```tsx
 * // middleware.ts
 * import { updateSession } from '@/lib/supabase/middleware'
 * import { applySessionContinuity } from '@/lib/supabase/session-continuity'
 *
 * export async function middleware(request: NextRequest) {
 *   const { response, supabase, sessionContinuity } = await updateSession(request)
 *
 *   // 認証チェック
 *   const { data: { user } } = await supabase.auth.getUser()
 *
 *   if (!user && isProtectedPath(request.nextUrl.pathname)) {
 *     // 新しい response を作る経路では、refresh Cookie / cache headers を明示的に写す（#2516）
 *     return applySessionContinuity(
 *       NextResponse.redirect(new URL('/auth/login', request.url)),
 *       sessionContinuity,
 *     )
 *   }
 *
 *   return response
 * }
 * ```
 *
 * 重要な役割:
 * 1. 期限切れトークンの自動リフレッシュ
 * 2. リフレッシュされたトークンをCookieに保存
 * 3. Server Components での重複リフレッシュを防止
 *
 * なぜMiddlewareでリフレッシュが必要か:
 * - Server Components は Cookie を書き込めない
 * - Middleware は全リクエストで実行されるため、
 *   トークンリフレッシュを一元管理できる
 * - CDN キャッシュとの競合を回避できる
 *
 * @see https://supabase.com/docs/guides/auth/server-side/nextjs
 */

import { captureUnexpectedAuthError } from '@/lib/sentry';
import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

import type { Database } from '@/lib/database';

import {
  applySessionContinuity,
  createEmptySessionContinuity,
  type SessionContinuity,
} from './session-continuity';

/**
 * Middlewareでセッションを更新（トークンリフレッシュ）
 *
 * この関数は以下を行います:
 * 1. リクエストから既存のセッションを読み込み
 * 2. 期限切れの場合、リフレッシュトークンで新しいアクセストークンを取得
 * 3. 更新されたトークンをレスポンスのCookieに書き込み
 * 4. Supabaseクライアントと更新されたレスポンスを返す
 *
 * @param request - Next.js Request オブジェクト
 * @returns { response, supabase } - 更新されたレスポンスとSupabaseクライアント
 */
export async function updateSession(request: NextRequest) {
  // レスポンスオブジェクトを作成（後でCookieを書き込む）
  let response = NextResponse.next({
    request,
  });

  // setAll() が渡す refresh Cookie / cache headers の持ち回り。呼び出し側（proxy.ts）が
  // updateSession() の後で新しい NextResponse を作る場合、これを applySessionContinuity()
  // で明示的に写す必要がある（#2516。ここで作った response を直接返す経路だけなら不要）。
  const sessionContinuity: SessionContinuity = createEmptySessionContinuity();

  // Supabaseクライアントを作成
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // `@supabase/ssr` は refresh 時、第2引数 headers に Cache-Control / Expires /
        // Pragma を渡す。CDN が Set-Cookie 付きレスポンスをキャッシュしないための no-cache
        // 指示で、落とすとセッション漏洩の経路になり得る（#2516、Supabase 公式ガイド）。
        setAll(cookiesToSet, headers) {
          // リクエストにCookieを設定（後続の処理で使用）
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          // 持ち回りへ反映（同名 Cookie は後勝ち。headers は setAll が複数回呼ばれても
          // 上書きマージでよい）
          const cookiesByName = new Map(sessionContinuity.cookies.map((c) => [c.name, c]));
          cookiesToSet.forEach((c) => cookiesByName.set(c.name, c));
          sessionContinuity.cookies = [...cookiesByName.values()];
          Object.assign(sessionContinuity.headers, headers ?? {});

          // レスポンスを再作成してCookieとheadersを含める
          response = applySessionContinuity(
            NextResponse.next({
              request,
            }),
            sessionContinuity,
          );
        },
      },
    },
  );

  // ⚠️ 重要: getUser() を呼び出すことで、期限切れトークンが自動リフレッシュされる
  // この呼び出しにより、上記の setAll() が実行され、新しいトークンがCookieに保存される
  // パフォーマンス最適化: ユーザー情報も返すことで、呼び出し元での重複取得を防止
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] = null;
  try {
    const authResult = await supabase.auth.getUser();
    captureUnexpectedAuthError(authResult.error, {
      operation: 'middleware_get_user',
      source: 'supabase_auth',
    });
    if (!authResult.error) user = authResult.data.user;
  } catch (error) {
    captureUnexpectedAuthError(error, {
      operation: 'middleware_get_user',
      source: 'supabase_auth',
    });
  }

  return { response, supabase, user, sessionContinuity };
}
