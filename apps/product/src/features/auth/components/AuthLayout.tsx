'use client';

import { Logo } from '@dayopt/components';

import type React from 'react';

import { usePathname } from 'next/navigation';

/** 認証ページ共通レイアウト。ログイン・サインアップ等の特定パスでは素通し、それ以外はカード中央配置 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // ログイン・サインアップ等のページは各ページが自前で 1 カラム中央寄せレイアウトを持つため、ラップしない
  if (
    pathname?.includes('/auth/login') ||
    pathname?.includes('/auth/signup') ||
    pathname?.includes('/auth/password') ||
    pathname?.includes('/auth/reset-password') ||
    pathname?.includes('/auth/mfa-verify')
  ) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-2">
      <Logo size="lg" />
      <div className="bg-card lg:border-border-subtle w-full max-w-sm p-6 lg:rounded-2xl lg:border lg:p-8 lg:shadow-sm">
        {children}
      </div>
    </main>
  );
}
