'use client';

/**
 * App レベル Error ページ
 *
 * (app) Route Group 内のページエラーをキャッチ。
 * BaseLayout（サイドバー等）の内側で描画されるため、
 * アプリの一部として自然に表示される。
 *
 * NextIntlClientProvider が利用可能なため i18n 対応。
 */

import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { logger } from '@/lib/logger';
import { attemptChunkLoadRecovery } from '@/lib/pwa/chunk-load-recovery';
import { captureClientBoundaryError } from '@/lib/sentry';
import { Button, Card } from '@dayopt/components';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({ error, reset }: ErrorProps) {
  const t = useTranslations('error.global');

  useEffect(() => {
    // リロードで解消する一過性なので 1 回目は capture しない。2 回目は通常どおり capture される。
    if (attemptChunkLoadRecovery(error)) {
      return;
    }
    logger.error('[App Error]', { errorType: error.name, digest: error.digest });
    captureClientBoundaryError(error, {
      feature: 'app',
      operation: 'render',
      route: window.location.pathname,
      source: 'app_error_boundary',
    });
  }, [error]);

  return (
    // eslint-disable-next-line tailwindcss/no-arbitrary-value -- viewport unit
    <div className="grid min-h-[60vh] w-full place-items-center p-8">
      <Card className="w-full max-w-md items-center gap-6 border-0 bg-transparent py-0 text-center shadow-none">
        <div className="border-destructive flex size-16 items-center justify-center rounded-full border-2">
          <AlertCircle className="text-destructive size-8" />
        </div>

        <div>
          <h2 className="mb-2 text-xl font-medium">{t('title')}</h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>

          {process.env.NODE_ENV === 'development' && error.message && (
            <div className="border-border bg-surface-container mt-4 rounded-lg border p-4 text-left">
              <p className="text-destructive font-mono text-xs">{error.message}</p>
            </div>
          )}
        </div>

        <div className="flex gap-4">
          <Button onClick={reset}>{t('retry')}</Button>
          <Button onClick={() => window.location.reload()} variant="outline">
            {t('goHome')}
          </Button>
        </div>

        <p className="text-muted-foreground text-xs">{t('sentryReport')}</p>
      </Card>
    </div>
  );
}
