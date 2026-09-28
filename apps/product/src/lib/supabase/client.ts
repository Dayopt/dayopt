/**
 * Supabase Browser Client
 *
 * Client Components用のSupabaseクライアント
 *
 * @see https://supabase.com/docs/guides/auth/server-side/creating-a-client
 * @see Issue #531 - Supabase × Vercel × Next.js 認証チェックリスト
 *
 * 使用箇所:
 * - Client Components ('use client')
 * - ブラウザ側での認証処理（サインイン/サインアウト/OAuth）
 * - onAuthStateChange リスナー
 *
 * 使用例:
 * ```tsx
 * 'use client'
 * import { createClient } from '@/lib/supabase/client'
 *
 * export function SignInButton() {
 *   const supabase = createClient()
 *
 *   const handleSignIn = async () => {
 *     const { data, error } = await supabase.auth.signInWithPassword({
 *       email: 'user@example.com',
 *       password: 'password'
 *     })
 *   }
 * }
 * ```
 *
 * 重要:
 * - このクライアントはブラウザでのみ動作します
 * - Server Components/Actions では server.ts を使用してください
 * - Middleware では middleware.ts を使用してください
 */

import { createBrowserClient } from '@supabase/ssr';

import type { Database } from '@/lib/database';
import { PRODUCT_INTEGRATION_APP_ORIGIN, resolveDayoptEnvironment } from '@/lib/dayopt-environment';

// next.config.mjs の env フォールバック値（env var 未設定時の build 用プレースホルダー）。
// ここと同じ値を保つ必要がある。
const PLACEHOLDER_SUPABASE_URL = 'https://placeholder.supabase.co';
const PLACEHOLDER_SUPABASE_ANON_KEY = 'placeholder';

/**
 * env var 未設定 / placeholder 値のまま起動された場合の設定エラー。
 * 呼び出し側（useAuthStore 等）が Supabase の認証エラーと区別して扱えるよう
 * 専用クラスにしている（instanceof で判定）。
 */
export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/**
 * Browser用Supabaseクライアント作成
 *
 * @returns Supabase Browser Client
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (
    !url ||
    !anonKey ||
    url === PLACEHOLDER_SUPABASE_URL ||
    anonKey === PLACEHOLDER_SUPABASE_ANON_KEY
  ) {
    throw new SupabaseConfigError(
      '❌ NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です:\n\n' +
        'これらは pnpm dev が Supabase local（supabase status -o env）から注入します。' +
        'pnpm dev で起動してください。詳細は docs/operations/secrets.md を参照してください。',
    );
  }

  const dayoptEnvironment = resolveDayoptEnvironment({
    dayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
    publicDayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
    vercelEnvironment: process.env.NEXT_PUBLIC_VERCEL_ENV,
    vercelTargetEnvironment: process.env.NEXT_PUBLIC_VERCEL_TARGET_ENV,
    vercelGitCommitRef: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF,
    vercelProjectId: process.env.NEXT_PUBLIC_VERCEL_PROJECT_ID,
    vercelBranchUrl: process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL,
    vercelUrl: process.env.NEXT_PUBLIC_VERCEL_URL,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    supabaseUrl: url,
  });
  if (dayoptEnvironment === 'unknown') {
    throw new SupabaseConfigError(
      'Supabase project does not match the configured Dayopt environment.',
    );
  }
  if (
    dayoptEnvironment === 'integration' &&
    typeof window !== 'undefined' &&
    window.location.origin !== PRODUCT_INTEGRATION_APP_ORIGIN
  ) {
    throw new SupabaseConfigError(
      'Integration Supabase access is restricted to its fixed app origin.',
    );
  }

  // #2728: tracePropagation は渡さない。@sentry/browser は @opentelemetry/api を
  // 使わないため global propagator が居らず、有効にしても header は付かない。
  return createBrowserClient<Database>(url, anonKey);
}
