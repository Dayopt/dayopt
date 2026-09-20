'use client';

import { useEffect } from 'react';

import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { selectSessionExpired, useAuthStore } from '../stores/useAuthStore';

import { useSessionMonitor } from '../hooks/useSessionMonitor';

import { SessionTimeoutDialog } from './SessionTimeoutDialog';

/**
 * セッション監視プロバイダー
 *
 * 認証済みページで使用し、セッションタイムアウトを監視する
 * タイムアウト警告時にダイアログを表示
 * セッション失効時にトースト通知 + ログインへリダイレクト
 *
 * Context を持たない副作用だけの component なので children を包まず、app 本体と並べて置く。
 * 包むと遅延ロードの chunk 到着まで本体の描画が止まる（#2747）。
 *
 * @example
 * ```tsx
 * <SessionMonitorProvider />
 * {children}
 * ```
 */
export function SessionMonitorProvider() {
  const { showTimeoutWarning, remainingTime, extendSession, logout } = useSessionMonitor();
  const sessionExpired = useAuthStore(selectSessionExpired);
  const router = useRouter();
  const t = useTranslations();

  // C2: セッション失効時の通知 + リダイレクト
  useEffect(() => {
    if (!sessionExpired) return;

    toast.error(t('auth.session.sessionExpired'));
    const timer = setTimeout(() => {
      router.push('/auth/login');
    }, 3000);
    return () => clearTimeout(timer);
  }, [sessionExpired, router, t]);

  return (
    <SessionTimeoutDialog
      open={showTimeoutWarning}
      remainingTime={remainingTime}
      onExtend={extendSession}
      onLogout={logout}
    />
  );
}
