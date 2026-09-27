/**
 * 認証ページ用レイアウト（Server Component）
 *
 * @description
 * 認証ページ（/auth/login, /auth/signup等）で使用。
 * IntlProvider で必要な翻訳のみクライアントに配信し、
 * クライアント側UIは AuthClientLayout に委譲する。
 *
 * Provider階層:
 * 1. IntlProvider（common + auth + error + navigation）
 * 2. AuthClientLayout → PublicProviders（Theme, Tooltip のみ）と AuthStoreInitializer
 * 3. AuthLayout（認証UI用レイアウト）
 */
import type { Metadata } from 'next';

import { IntlProvider } from '@/lib/i18n';

import { AuthClientLayout } from './client-layout';

/**
 * 認証ページで必要なnamespace。
 *
 * `navigation` は #2144 の /auth/session-error にある sign-out ボタンが
 * `useLogout`（`navigation.navUser.*` キーでtoastを出す）を再利用するために必要。
 * useLogout はナビバー等でも共有される hook のため、呼び出し側ごとに文言を
 * 差し替えるより、この namespace を配信する方が hook の単純さを保てる。
 */
const AUTH_NAMESPACES = ['common', 'auth', 'error', 'navigation'];

/** 認証ページはクロール不要（noindex） */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AuthRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <IntlProvider namespaces={AUTH_NAMESPACES}>
      <AuthClientLayout>{children}</AuthClientLayout>
    </IntlProvider>
  );
}
