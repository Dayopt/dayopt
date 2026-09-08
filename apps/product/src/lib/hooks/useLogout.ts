'use client';

import { useState } from 'react';

import { logger } from '@/lib/logger';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { clearPersistedQueryCache } from '@/lib/tanstack-query/persist-storage';
import { toast } from '@/lib/toast';
import { useRouter } from '@dayopt/i18n/navigation';
import { useTranslations } from 'next-intl';

/**
 * ログアウト処理を提供するhook
 *
 * Supabase Auth のサインアウト → トースト通知 → ログインページへリダイレクト
 *
 * @example
 * ```tsx
 * const { logout, isLoggingOut } = useLogout();
 * <Button onClick={logout} disabled={isLoggingOut}>Logout</Button>
 * ```
 */
export function useLogout() {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const t = useTranslations();

  const logout = async () => {
    setIsLoggingOut(true);
    try {
      const supabase = createClient();
      await observeAuthOperation('sign_out', () => supabase.auth.signOut());
      // 永続化された query cache（IndexedDB）を破棄する（#2619）。sign-out は soft
      // navigation なので、消さないと同じブラウザの次のユーザーに前ユーザーの
      // plan / record が復元されうる。memory 側は QueryCacheAuthBoundary が閉じる。
      await clearPersistedQueryCache();
      toast.success(t('navigation.navUser.logoutSuccess'));
      router.push('/auth/login');
      router.refresh();
    } catch (error) {
      logger.error('Logout error:', error);
      toast.error(t('navigation.navUser.logoutFailed'));
    } finally {
      setIsLoggingOut(false);
    }
  };

  return { logout, isLoggingOut };
}
