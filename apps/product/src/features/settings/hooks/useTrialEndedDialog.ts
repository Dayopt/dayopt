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
 * 旧Free/Pro方式のTrial終了ダイアログの表示判定 + フラグ管理
 * 単一有料プランでは利用状態に基づくinline bannerを使う。
 * Stripe Customerの存在は45日体験の終了を意味しない。
 *
 * 表示条件（すべて満たす場合のみ）:
 * 1. subscriptionStatus === 'free'
 * 2. stripeCustomerId が存在する（= Trial を経験した）
 * 3. dismissedTrialEndedDialog フラグが false
 *
 * close() は UI を即座に閉じる（local state で optimistic dismiss）、
 * 裏で personalization に dismissedTrialEndedDialog: true を保存する。
 * 失敗時も local dismiss は保持し、ユーザーがダイアログに閉じ込められないようにする。
 */
export function useTrialEndedDialog(): UseTrialEndedDialogResult {
  const { enforced } = useBillingAccess();
  const billingQuery = api.billing.getOverview.useQuery(undefined, {
    retry: false,
  });
  const settingsQuery = api.userSettings.get.useQuery();
  const updateSettings = useUpdateUserSettings();

  const [locallyDismissed, setLocallyDismissed] = useState(false);

  const close = useCallback(() => {
    setLocallyDismissed(true);
    updateSettings.mutate({ dismissedTrialEndedDialog: true });
  }, [updateSettings]);

  const open = useMemo(() => {
    if (enforced || locallyDismissed) return false;

    const billing = billingQuery.data?.billingInfo;
    const settings = settingsQuery.data;

    if (!billing || settings === undefined) return false;

    return (
      billing.subscriptionStatus === 'free' &&
      billing.stripeCustomerId !== null &&
      !settings?.personalization.dismissedTrialEndedDialog
    );
  }, [billingQuery.data, settingsQuery.data, locallyDismissed, enforced]);

  return { open, close };
}
