import 'server-only';

/**
 * Supabase Server Client
 *
 * Server Components/Server Actions/Route Handlers用のSupabaseクライアント
 *
 * @see https://supabase.com/docs/guides/auth/server-side/creating-a-client
 * @see Issue #531 - Supabase × Vercel × Next.js 認証チェックリスト
 *
 * 使用箇所:
 * - Server Components
 * - Server Actions
 * - Route Handlers (app/api/*)
 *
 * 使用例:
 * ```tsx
 * // Server Component
 * import { createClient } from '@/lib/supabase/server'
 *
 * export default async function DashboardPage() {
 *   const supabase = createClient()
 *   const { data: { user } } = await supabase.auth.getUser()
 *
 *   if (!user) {
 *     redirect('/auth/login')
 *   }
 *
 *   return <div>Welcome {user.email}</div>
 * }
 * ```
 *
 * ```tsx
 * // Server Action
 * 'use server'
 * import { createClient } from '@/lib/supabase/server'
 *
 * export async function updateProfile(formData: FormData) {
 *   const supabase = createClient()
 *   const { data: { user } } = await supabase.auth.getUser()
 *
 *   if (!user) {
 *     throw new Error('Not authenticated')
 *   }
 *
 *   // Update profile...
 * }
 * ```
 *
 * 重要:
 * - このクライアントはサーバーサイドでのみ動作します
 * - Client Components では client.ts を使用してください
 * - Middleware では middleware.ts を使用してください
 * - Server Components は Cookie を書き込めないため、
 *   トークンリフレッシュは Middleware で行います
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { env } from '@/env';
import type { Database } from '@/lib/database';

/**
 * Server用Supabaseクライアント作成
 *
 * Next.js の cookies() を使用してCookieベースの認証を実装
 *
 * @returns Supabase Server Client
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Component内で呼ばれた場合、setは失敗する可能性がある
            // これは正常な動作で、Middlewareでトークンリフレッシュが行われる
          }
        },
      },
      global: {
        fetch: (url, options) => {
          return fetch(url, {
            ...options,
            signal: options?.signal ?? AbortSignal.timeout(15_000),
          });
        },
      },
    },
  );
}
