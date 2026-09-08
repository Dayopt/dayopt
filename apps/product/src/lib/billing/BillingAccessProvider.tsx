'use client';

import { api } from '@/lib/trpc';
import type { BillingAccess } from '@dayopt/billing';
import { Button } from '@dayopt/components';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useEffect, useState } from 'react';

const BillingAccessContext = createContext<BillingAccess>({
  state: 'not_started',
  canUseProduct: true,
  trialEndsAt: null,
  enforced: false,
});

export function useBillingAccess(): BillingAccess {
  return useContext(BillingAccessContext);
}

/** The authenticated application mounts this once; public pages never mount it. */
export function BillingAccessProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const utils = api.useUtils();
  const query = api.billing.getAccess.useQuery(undefined, {
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: 'always',
    meta: { persist: false },
  });
  const trial = api.billing.startTrial.useMutation({
    retry: false,
    onSuccess(access) {
      utils.billing.getAccess.setData(undefined, access);
      void utils.billing.getOverview.invalidate();
    },
  });
  useEffect(() => {
    void utils.billing.getOverview.invalidate();
  }, [query.data?.state, utils]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (query.data?.enforced && query.data.state === 'not_started' && trial.isIdle) trial.mutate();
  }, [query.data, trial]);
  useEffect(() => {
    if (!query.data?.trialEndsAt || query.data.state !== 'trial') return;
    if (Date.parse(query.data.trialEndsAt) <= now) return;
    const remaining = Date.parse(query.data.trialEndsAt) - Date.now();
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void query.refetch();
      },
      Math.min(Math.max(0, remaining), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [query, now]);

  if ((!query.data && query.isError) || (query.data?.state === 'not_started' && trial.isError)) {
    return (
      <div role="alert" className="p-6">
        <p>{t('errors.loadFailedDescription')}</p>
        <Button
          onClick={() => {
            trial.reset();
            void query.refetch();
          }}
        >
          {t('actions.retry')}
        </Button>
      </div>
    );
  }
  if (!query.data || (query.data.enforced && query.data.state === 'not_started')) return null;
  const access = query.data;
  const expired =
    access.enforced &&
    access.state === 'trial' &&
    access.trialEndsAt !== null &&
    Date.parse(access.trialEndsAt) <= now;
  return (
    <BillingAccessContext.Provider
      value={
        expired
          ? { ...access, state: 'expired', canUseProduct: false }
          : query.isError
            ? { ...access, canUseProduct: false }
            : access
      }
    >
      {children}
    </BillingAccessContext.Provider>
  );
}
