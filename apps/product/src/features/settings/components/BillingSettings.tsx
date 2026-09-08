'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { toast } from '@/lib/toast';
import { dayoptPricing, getPlanIdForSubscriptionStatus, isPaidPlan } from '@dayopt/billing';
import { Badge } from '@dayopt/components';
import { AlertTriangle, CreditCard, Crown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { LabeledRow } from '@/components/ui/display/LabeledRow';
import { SectionCard } from '@/components/ui/display/SectionCard';
import { ErrorState } from '@/components/ui/feedback/ErrorState';
import { api } from '@/lib/trpc';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Skeleton,
} from '@dayopt/components';

import { useStableBillingOperation } from '../hooks/useStableBillingOperation';
import { getBillingOperationErrorPresentation } from '../lib/billing-operation';
import { useBillingPollStore } from '../stores/useBillingPollStore';

/**
 * Stripe Price ID
 *
 * Stripe Dashboard で作成した Price の ID を環境変数で管理。
 * ビルド時に埋め込まれるため NEXT_PUBLIC_ プレフィックス。
 */
const STRIPE_PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID ?? '';

/** 請求・サブスクリプション設定コンポーネント。プラン変更・支払方法・請求履歴・キャンセルを管理 */
export function BillingSettings() {
  const t = useTranslations();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const timezone = useUserPreferences((s) => s.timezone);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [billingActionsClosed, setBillingActionsClosed] = useState(false);
  const {
    begin: beginCheckoutAttempt,
    isLocked: isCheckoutAttemptLocked,
    settle: settleCheckoutAttempt,
  } = useStableBillingOperation();
  const {
    begin: beginPortalAttempt,
    isLocked: isPortalAttemptLocked,
    settle: settlePortalAttempt,
  } = useStableBillingOperation();

  // Checkout 復帰（?success=true / ?canceled=true）の toast は
  // settings/[category]/page.tsx が処理する。PC ではこの component が mount される前に
  // openSettings + router.replace('/') で query が消えるため、ここで searchParams を
  // 読んでも間に合わない。

  // 統合エンドポイントで一括取得（N+1 解消）。refetchInterval は useAppInlineBanner
  // 側で有効化される（app shell に常駐し、settings modal の開閉に依存しないため）。
  const overview = api.billing.getOverview.useQuery(undefined, {
    retry: false,
  });
  // Checkout 成功復帰直後のポーリング中は、まだ Free のまま見えていても
  // 「反映中」であることをユーザーに伝える（issue #1887）。
  const isPollingAfterCheckout = useBillingPollStore.use.startedAt() !== null;

  const subscriptionStatus = overview.data?.billingInfo.subscriptionStatus;
  const trialEndsAt = overview.data?.trialEndsAt ?? null;
  const access = overview.data?.access;
  const currentPlan = getPlanIdForSubscriptionStatus(subscriptionStatus);
  const canAccessPro = isPaidPlan(currentPlan);

  // Portal Session 作成（checkout 失敗時の出口としても使うため checkout より先に定義する）
  const createPortal = api.billing.createPortalSession.useMutation({
    onSuccess(data, variables) {
      if (!variables) return;
      if (settlePortalAttempt(variables.operationId, 'terminal')) {
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

      if (closesBillingActions) setBillingActionsClosed(true);
      toast.error(t(messageKey));
    },
  });

  // Checkout Session 作成
  const createCheckout = api.billing.createCheckoutSession.useMutation({
    onSuccess(data, variables) {
      if (!variables) return;
      if (settleCheckoutAttempt(variables.operationId, 'terminal')) {
        window.location.href = data.url;
      }
    },
    onError(error, variables) {
      if (!variables) return;
      const { closesBillingActions, messageKey, needsBillingPortal, retryable } =
        getBillingOperationErrorPresentation(error);
      const isCurrent = settleCheckoutAttempt(
        variables.operationId,
        retryable ? 'retryable' : 'terminal',
      );
      if (!isCurrent) return;

      if (closesBillingActions) setBillingActionsClosed(true);

      // 既にサブスクリプションがある場合、Pro 向けの portal ボタンは canAccessPro で
      // 隠れている（Stripe が unpaid / paused でも profiles 上は free 扱いになるため）。
      // 再試行しても必ず同じ失敗を返すので、唯一の出口を toast の action で渡す。
      if (needsBillingPortal) {
        toast.error(t(messageKey), {
          action: {
            label: t('settings.subscription.managePlan'),
            onClick: () => {
              const portalOperationId = beginPortalAttempt();
              if (portalOperationId) createPortal.mutate({ operationId: portalOperationId });
            },
          },
        });
        return;
      }

      toast.error(t(messageKey));
    },
  });

  const handleUpgrade = useCallback(() => {
    if (!STRIPE_PRICE_ID) {
      toast.error(t('settings.subscription.stripeNotConfigured'));
      return;
    }
    const operationId = beginCheckoutAttempt();
    if (operationId) createCheckout.mutate({ operationId });
  }, [beginCheckoutAttempt, createCheckout, t]);

  const handleManageSubscription = useCallback(() => {
    const operationId = beginPortalAttempt();
    if (operationId) createPortal.mutate({ operationId });
  }, [beginPortalAttempt, createPortal]);

  const handleCancelConfirm = useCallback(() => {
    setCancelDialogOpen(false);
    const operationId = beginPortalAttempt();
    if (operationId) createPortal.mutate({ operationId });
  }, [beginPortalAttempt, createPortal]);

  // Intl フォーマッターをメモ化
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: timezone,
      }),
    [timezone],
  );

  const formatCurrency = useCallback((amount: number, currency: string) => {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amount);
  }, []);

  const isStripeConfigured = STRIPE_PRICE_ID !== '';
  const isMutating = createCheckout.isPending || createPortal.isPending;
  const areBillingActionsDisabled =
    billingActionsClosed || isCheckoutAttemptLocked || isPortalAttemptLocked || isMutating;

  // ローディング状態（P0-2）
  if (overview.isLoading) {
    return (
      <div className="space-y-6 sm:space-y-8">
        {[0, 1].map((i) => (
          <SectionCard key={i}>
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          </SectionCard>
        ))}
      </div>
    );
  }

  // エラー状態（P1-6）
  if (overview.isError) {
    return (
      <div className="space-y-6 sm:space-y-8">
        <SectionCard>
          <ErrorState
            title={t('settings.subscription.loadError')}
            onRetry={() => overview.refetch()}
            size="sm"
            centered
          />
        </SectionCard>
      </div>
    );
  }

  const paymentMethodData = overview.data?.paymentMethod;
  const invoicesData = overview.data?.invoices ?? [];

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* 現在のプラン */}
      <SectionCard title={t('settings.subscription.currentPlan')}>
        <div className="flex items-center gap-4 py-2">
          <div className="bg-state-active flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
            <Crown className="text-state-active-foreground h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="text-lg font-medium">{t('settings.subscription.singlePlan.name')}</h4>
              <Badge variant="secondary">{t('settings.subscription.currentBadge')}</Badge>
              {subscriptionStatus === 'trialing' && (
                <Badge variant="outline">{t('settings.subscription.trialBadge')}</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-base md:text-sm">
              {access?.enforced
                ? t(`settings.subscription.singlePlan.${access.state}`)
                : t('settings.subscription.singlePlan.disabled')}
            </p>
            {/* Checkout 成功直後、webhook 反映待ちでまだ Free に見えている間の一時表示 */}
            {isPollingAfterCheckout && !canAccessPro && (
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.subscription.syncingPlan')}
              </p>
            )}
            {/* Stripe から期限を取れなかった場合は表示しない（Badge と説明文は従来どおり出る） */}
            {access?.state === 'trial' && trialEndsAt && (
              <p>
                {t('settings.subscription.singlePlan.remainingDays', {
                  days: Math.max(0, Math.ceil((Date.parse(trialEndsAt) - now) / 86_400_000)),
                })}
              </p>
            )}
            {trialEndsAt && (
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.subscription.trialEndsAt', {
                  date: dateFormatter.format(new Date(trialEndsAt)),
                })}
              </p>
            )}
          </div>
          {canAccessPro && (
            <Button
              variant="outline"
              onClick={handleManageSubscription}
              disabled={areBillingActionsDisabled}
              className="shrink-0"
            >
              {t('settings.subscription.adjustPlan')}
            </Button>
          )}
        </div>
      </SectionCard>

      {/* 支払い失敗警告（past_due 時のみ） */}
      {subscriptionStatus === 'past_due' && (
        <SectionCard>
          <div className="bg-warning-tint flex items-center gap-4 rounded-lg p-4">
            <AlertTriangle className="text-warning h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-base md:text-sm">{t('settings.subscription.pastDueTitle')}</p>
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.subscription.pastDueDescription')}
              </p>
            </div>
            <Button
              variant="outline"
              className="ml-auto shrink-0"
              onClick={handleManageSubscription}
              disabled={areBillingActionsDisabled}
            >
              {t('settings.subscription.updatePayment')}
            </Button>
          </div>
        </SectionCard>
      )}

      {/* キャンセル済み通知（canceled 時のみ） */}
      {subscriptionStatus === 'canceled' && access?.enforced && (
        <SectionCard>
          <div className="flex items-center gap-4 rounded-lg p-4">
            <AlertTriangle className="text-muted-foreground h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-base md:text-sm">{t('settings.subscription.canceledTitle')}</p>
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.subscription.canceledDescription')}
              </p>
            </div>
            <Button
              variant="primary"
              className="ml-auto shrink-0"
              disabled={!isStripeConfigured || areBillingActionsDisabled}
              onClick={handleUpgrade}
            >
              {isMutating
                ? t('settings.subscription.processing')
                : t('settings.subscription.resubscribe')}
            </Button>
          </div>
        </SectionCard>
      )}

      {!canAccessPro && subscriptionStatus !== 'canceled' && (
        <SectionCard title={t('settings.subscription.singlePlan.name')}>
          <p>{t('settings.subscription.singlePlan.included')}</p>
          {access?.enforced && (
            <p className="text-muted-foreground text-sm">
              {t('settings.subscription.singlePlan.purchaseNow')}
            </p>
          )}
          <p className="text-lg">
            {dayoptPricing.pro.displayPrice}
            {t('settings.subscription.perMonth')}
          </p>
          <Button
            onClick={handleUpgrade}
            disabled={!isStripeConfigured || areBillingActionsDisabled}
          >
            {isMutating
              ? t('settings.subscription.processing')
              : t('settings.subscription.singlePlan.purchase')}
          </Button>
        </SectionCard>
      )}

      {/* お支払い方法（Pro ユーザーのみ表示） */}
      {canAccessPro && (
        <SectionCard title={t('settings.subscription.paymentMethod')}>
          <LabeledRow
            label={
              paymentMethodData ? (
                <span className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4" />
                  <span className="capitalize">{paymentMethodData.brand}</span>
                  {' •••• '}
                  {paymentMethodData.last4}
                  <span className="text-muted-foreground text-xs">
                    {String(paymentMethodData.expMonth).padStart(2, '0')}/
                    {paymentMethodData.expYear}
                  </span>
                </span>
              ) : (
                t('settings.subscription.noCard')
              )
            }
          >
            <Button
              variant="outline"
              onClick={handleManageSubscription}
              disabled={areBillingActionsDisabled}
            >
              {t('settings.subscription.updateCard')}
            </Button>
          </LabeledRow>
        </SectionCard>
      )}

      {/* 請求履歴 — overflow-x-auto でモバイル対応（P1-5） */}
      {canAccessPro && (
        <SectionCard title={t('settings.subscription.billingHistory')}>
          {invoicesData.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs">
                    <th className="pb-2">{t('settings.subscription.invoiceDate')}</th>
                    <th className="pb-2">{t('settings.subscription.invoiceTotal')}</th>
                    <th className="pb-2">{t('settings.subscription.invoiceStatus')}</th>
                    <th className="pb-2 text-right">{t('settings.subscription.invoiceAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoicesData.map((invoice) => (
                    <tr key={invoice.id} className="text-sm">
                      <td className="py-2 whitespace-nowrap">
                        {dateFormatter.format(new Date(invoice.date))}
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        {formatCurrency(invoice.amount / 100, invoice.currency)}
                      </td>
                      <td className="py-2">
                        <Badge variant="secondary">
                          {invoice.status === 'paid'
                            ? t('settings.subscription.invoicePaid')
                            : invoice.status}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">
                        {invoice.hostedInvoiceUrl && (
                          <a
                            href={invoice.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary text-sm hover:underline"
                          >
                            {t('settings.subscription.invoiceView')}
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground py-6 text-center text-base md:text-sm">
              {t('settings.subscription.noInvoices')}
            </p>
          )}
        </SectionCard>
      )}

      {/* キャンセル — 確認ダイアログ付き（P0-1） */}
      {canAccessPro && (
        <SectionCard title={t('settings.subscription.cancelTitle')}>
          <LabeledRow label={t('settings.subscription.cancelDescription')}>
            <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={areBillingActionsDisabled}>
                  {t('settings.subscription.cancelButton')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('settings.subscription.cancelConfirmTitle')}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('settings.subscription.cancelConfirmDescription')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t('settings.subscription.cancelConfirmCancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleCancelConfirm}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive-hover"
                  >
                    {t('settings.subscription.cancelConfirmAction')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </LabeledRow>
        </SectionCard>
      )}
    </div>
  );
}
