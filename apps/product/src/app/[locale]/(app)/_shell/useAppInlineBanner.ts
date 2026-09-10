'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useShellStore } from '@/lib/stores/useShellStore';
import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

import {
  BILLING_POLL_INTERVAL_MS,
  BILLING_POLL_MAX_DURATION_MS,
  getBillingOperationErrorPresentation,
  hasBillingPollTimedOut,
  reportBillingReturnPollTimeout,
  shouldContinueBillingPoll,
  useBillingPollStore,
  useStableBillingOperation,
} from '@/features/settings';

import type { InlineBannerAction } from '@dayopt/components';

interface InlineBannerState {
  visible: boolean;
  message: string;
  action?: InlineBannerAction;
}

/**
 * InlineBanner の app-level composition フック
 *
 * feature 層の billing 状態（past_due）と Service Worker 更新状態を合成する。
 *
 * 優先度（高→低）:
 * 1. 決済エラー（Pro失効リスク）
 * 2. Service Worker 更新（#2232、開きっぱなしの画面が旧シェルのまま残る）
 */
export function useAppInlineBanner(): InlineBannerState {
  const t = useTranslations();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const access = useBillingAccess();
  const timezone = useUserPreferences((s) => s.timezone);
  const utils = api.useUtils();
  const openSettings = useShellStore.use.openSettings();
  const [billingActionClosed, setBillingActionClosed] = useState(false);
  const serviceWorkerUpdateAvailable = useShellStore.use.serviceWorkerUpdateAvailable();
  const {
    begin: beginPortalAttempt,
    isLocked: isPortalAttemptLocked,
    settle: settlePortalAttempt,
  } = useStableBillingOperation();

  // Checkout 成功復帰直後（settings/[category]/page.tsx が useBillingPollStore を
  // start する）だけ短い間隔で再取得する。webhook 経由の subscription_status 反映が
  // invalidate に追いつかないケースの救済（issue #1887）。この hook は app shell に
  // 常駐するため、settings modal の開閉に関係なくポーリングを継続できる。
  const pollStartedAt = useBillingPollStore.use.startedAt();
  const stopBillingPoll = useBillingPollStore.use.stop();
  const reportedBillingPollStartedAtRef = useRef<number | null>(null);

  const billingQuery = api.billing.getOverview.useQuery(undefined, {
    retry: false,
    refetchInterval: (query) => {
      if (pollStartedAt === null) return false;
      const status = query.state.data?.billingInfo.subscriptionStatus;
      return shouldContinueBillingPoll({ startedAt: pollStartedAt, subscriptionStatus: status })
        ? BILLING_POLL_INTERVAL_MS
        : false;
    },
  });

  useEffect(() => {
    if (pollStartedAt === null) return;
    const status = billingQuery.data?.billingInfo.subscriptionStatus;
    if (!shouldContinueBillingPoll({ startedAt: pollStartedAt, subscriptionStatus: status })) {
      if (
        hasBillingPollTimedOut({ startedAt: pollStartedAt, subscriptionStatus: status }) &&
        reportedBillingPollStartedAtRef.current !== pollStartedAt
      ) {
        reportedBillingPollStartedAtRef.current = pollStartedAt;
        reportBillingReturnPollTimeout(t('settings.subscription.checkoutDelayed'));
      }
      stopBillingPoll();
      void utils.billing.getAccess.invalidate();
      return;
    }
    // webhook 未達のまま data が変化しないと、この effect は再実行されず
    // startedAt が残って「反映中」表示が消えない。refetchInterval の自然停止とは
    // 別に、打ち切り時刻（+ 最終 refetch の着地猶予 1 interval）で必ず stop する
    const remainingMs = BILLING_POLL_MAX_DURATION_MS - (Date.now() - pollStartedAt);
    const timer = setTimeout(
      () => {
        if (reportedBillingPollStartedAtRef.current !== pollStartedAt) {
          reportedBillingPollStartedAtRef.current = pollStartedAt;
          reportBillingReturnPollTimeout(t('settings.subscription.checkoutDelayed'));
        }
        stopBillingPoll();
        void utils.billing.getAccess.invalidate();
      },
      Math.max(remainingMs, 0) + BILLING_POLL_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [billingQuery.data, pollStartedAt, stopBillingPoll, t, utils]);
  const createPortal = api.billing.createPortalSession.useMutation({
    onSuccess(data, variables) {
      if (!variables) return;
      if (data?.url && settlePortalAttempt(variables.operationId, 'terminal')) {
        window.location.href = data.url;
      }
    },
    onError(error, variables) {
      if (!variables) return;
      const { closesBillingActions, messageKey, retryable } =
        getBillingOperationErrorPresentation(error);
      const isCurrent = settlePortalAttempt(
        variables.operationId,
        retryable ? 'retryable' : 'terminal',
      );
      if (!isCurrent) return;

      if (closesBillingActions) setBillingActionClosed(true);
      toast.error(t(messageKey));
    },
  });

  const isPastDue = billingQuery.data?.billingInfo.subscriptionStatus === 'past_due';

  return useMemo(() => {
    // Priority 1: 決済エラー
    if (isPastDue) {
      return {
        visible: true,
        message: billingActionClosed
          ? t('common.billingOperation.accountClosing')
          : t('common.inlineBanner.paymentError'),
        action: {
          disabled: billingActionClosed || createPortal.isPending || isPortalAttemptLocked,
          label: t('common.inlineBanner.checkPayment'),
          onClick: () => {
            const operationId = beginPortalAttempt();
            if (operationId) createPortal.mutate({ operationId });
          },
        },
      };
    }

    if (
      access.enforced &&
      (access.state === 'expired' ||
        (access.state === 'trial' &&
          access.trialEndsAt &&
          Date.parse(access.trialEndsAt) - now <= 7 * 86_400_000))
    ) {
      return {
        visible: true,
        message:
          access.state === 'expired'
            ? t('settings.subscription.singlePlan.expired')
            : t('settings.subscription.singlePlan.ending', {
                date: new Date(access.trialEndsAt!).toLocaleString(undefined, {
                  timeZone: timezone,
                }),
              }),
        action: {
          label: t('settings.subscription.singlePlan.purchase'),
          onClick: () => openSettings('billing'),
        },
      };
    }

    // Priority 2: Service Worker 更新（自動リロードはしない。編集中データの喪失を
    // 避けるため、ユーザーの明示操作でのみ反映する）
    if (serviceWorkerUpdateAvailable) {
      return {
        visible: true,
        message: t('common.inlineBanner.updateAvailable'),
        action: {
          label: t('common.inlineBanner.reload'),
          onClick: () => window.location.reload(),
        },
      };
    }

    return { visible: false, message: '' };
  }, [
    access,
    now,
    timezone,
    openSettings,
    beginPortalAttempt,
    billingActionClosed,
    createPortal,
    isPastDue,
    isPortalAttemptLocked,
    serviceWorkerUpdateAvailable,
    t,
  ]);
}
