'use client';

import { useState } from 'react';

import { Button, Input, Skeleton } from '@dayopt/components';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { LabeledRow } from '@/components/ui/display/LabeledRow';
import { SectionCard } from '@/components/ui/display/SectionCard';
import { ErrorState } from '@/components/ui/feedback/ErrorState';
import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

type ICalFeedSettingsViewProps = {
  feedUrl: string | null;
  loading: boolean;
  error: boolean;
  regenerating: boolean;
  copied: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onGenerate: () => void;
};

export function ICalFeedSettingsView({
  feedUrl,
  loading,
  error,
  regenerating,
  copied,
  onRetry,
  onCopy,
  onGenerate,
}: ICalFeedSettingsViewProps) {
  const t = useTranslations('settings.integrations.icalFeed');

  return (
    <SectionCard title={t('title')}>
      <p className="text-muted-foreground mb-4 text-sm">{t('description')}</p>
      {loading ? (
        <div className="space-y-3 py-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-32" />
        </div>
      ) : error ? (
        <ErrorState title={t('loadError')} onRetry={onRetry} size="sm" />
      ) : feedUrl ? (
        <>
          <LabeledRow label={t('feedUrl')}>
            <div className="flex w-48 max-w-full items-center gap-2 sm:w-80">
              <Input
                value={feedUrl}
                readOnly
                className="min-w-0 flex-1 font-mono text-xs"
                aria-label={t('feedUrl')}
              />
              <Button variant="outline" size="sm" icon onClick={onCopy} aria-label={t('copy')}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </LabeledRow>
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onGenerate}
              loading={regenerating}
              loadingText={t('regenerating')}
            >
              <RefreshCw className="size-4" />
              {t('regenerate')}
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">{t('noToken')}</p>
          <Button
            size="sm"
            onClick={onGenerate}
            loading={regenerating}
            loadingText={t('generating')}
          >
            {t('generate')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

export function ICalFeedSettings() {
  const t = useTranslations('settings.integrations.icalFeed');
  const utils = api.useUtils();
  const hasMounted = useHasMounted();
  const origin = hasMounted ? window.location.origin : null;
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const tokenQuery = api.userSettings.getICalToken.useQuery(undefined, {
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    meta: { persist: false },
  });

  const regenerate = api.userSettings.regenerateICalToken.useMutation({
    retry: false,
    onSuccess: () => {
      setConfirmOpen(false);
      toast.success(t('regenerateSuccess'));
    },
    onError: () => toast.error(t('regenerateFailed')),
    onSettled: async () => {
      await utils.userSettings.getICalToken.invalidate();
      await tokenQuery.refetch();
    },
  });

  const token = tokenQuery.data?.token ?? null;
  const feedUrl = origin && token ? `${origin}/api/v1/calendar/${token}.ics` : null;
  const generate = () => {
    if (token) setConfirmOpen(true);
    else regenerate.mutate();
  };

  const copy = async () => {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      toast.success(t('copied'));
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <>
      <ICalFeedSettingsView
        feedUrl={feedUrl}
        loading={
          tokenQuery.isLoading || tokenQuery.isFetching || (token !== null && origin === null)
        }
        error={tokenQuery.isError}
        regenerating={regenerate.isPending}
        copied={copied}
        onRetry={() => void tokenQuery.refetch()}
        onCopy={() => void copy()}
        onGenerate={generate}
      />
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          await regenerate.mutateAsync().catch(() => undefined);
        }}
        title={t('regenerateConfirmTitle')}
        description={t('regenerateConfirmDescription')}
        confirmLabel={t('regenerate')}
        loadingLabel={t('regenerating')}
        variant="warning"
      />
    </>
  );
}
