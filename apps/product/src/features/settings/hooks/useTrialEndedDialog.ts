'use client';

import { useCallback, useMemo, useState } from 'react';

import { useBillingAccess } from '@/lib/billing/billing-access-context';
import { useUpdateUserSettings } from '@/lib/hooks/useUpdateUserSettings';
import { api } from '@/lib/trpc';

interface UseTrialEndedDialogResult {
  open: boolean;
  close: () => void;
}

/**
 * Trial終了ダイアログの表示判定 + フラグ管理
 *
 * 表示条件（すべて満たす場合のみ）:
 * 1. 課金制御が有効
 * 2. BillingAccessProvider が期限終了と判定している
 * 3. dismissedTrialEndedDialog フラグが false
 *
 * close() は UI を即座に閉じる（local state で optimistic dismiss）、
 * 裏で personalization に dismissedTrialEndedDialog: true を保存する。
 * 失敗時も local dismiss は保持し、ユーザーがダイアログに閉じ込められないようにする。
 */
export function useTrialEndedDialog(): UseTrialEndedDialogResult {
  const access = useBillingAccess();
  const settingsQuery = api.userSettings.get.useQuery();
  const updateSettings = useUpdateUserSettings();

  const [locallyDismissed, setLocallyDismissed] = useState(false);

  const close = useCallback(() => {
    setLocallyDismissed(true);
    updateSettings.mutate({ dismissedTrialEndedDialog: true });
  }, [updateSettings]);

  const open = useMemo(() => {
    if (locallyDismissed) return false;

    const settings = settingsQuery.data;

    if (settings === undefined) return false;

    return (
      access.enforced &&
      access.state === 'expired' &&
      !settings?.personalization.dismissedTrialEndedDialog
    );
  }, [access.enforced, access.state, settingsQuery.data, locallyDismissed]);

  return { open, close };
}
