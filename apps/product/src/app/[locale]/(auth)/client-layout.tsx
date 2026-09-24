/**
 * 認証ページ用クライアントレイアウト
 *
 * 軽量なPublicProvidersと認証ストア初期化のみを適用し、tRPC、Realtime購読等の
 * 重い機能は含まない。
 *
 * @see src/shell/providers/PublicProviders.tsx - 軽量Providers定義
 */
'use client';

import { Toaster } from '@/components/ui/feedback/toast';
import { AuthLayout, AuthStoreInitializer } from '@/features/auth';
import { PublicProviders } from './_providers/PublicProviders';

export function AuthClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicProviders>
      <AuthStoreInitializer />
      <AuthLayout>{children}</AuthLayout>
      <Toaster />
    </PublicProviders>
  );
}
