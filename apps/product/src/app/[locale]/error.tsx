'use client';

/**
 * Locale レベル Error ページ
 *
 * [locale] 配下の全 Route Group（(app), (auth)）の
 * エラーをキャッチする共通フォールバック。
 *
 * layout.tsx 自体のエラーでも描画されるため、NextIntlClientProvider の
 * コンテキストが存在しない場合がある。そのため i18n は使わずハードコード文字列を使用。
 */

import { AlertCircle } from 'lucide-react';
import { useEffect } from 'react';

import { logger } from '@/lib/logger';
import { attemptChunkLoadRecovery } from '@/lib/pwa/chunk-load-recovery';
import { captureClientBoundaryError } from '@/lib/sentry';
import { Button, Card } from '@dayopt/components';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function LocaleError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // リロードで解消する一過性なので 1 回目は capture しない。2 回目は通常どおり capture される。
    if (attemptChunkLoadRecovery(error)) {
      return;
    }
    logger.error('[Locale Error]', { errorType: error.name, digest: error.digest });
    captureClientBoundaryError(error, {
      feature: 'locale',
      operation: 'render',
      route: window.location.pathname,
      source: 'locale_error_boundary',
    });
  }, [error]);

  return (
    <div className="bg-background fixed inset-0 flex items-center justify-center overflow-auto p-4">
      <Card className="w-full max-w-md items-center gap-6 border-0 bg-transparent py-0 text-center shadow-none">
        <div className="border-destructive flex size-16 items-center justify-center rounded-full border-2">
          <AlertCircle className="text-destructive size-8" />
        </div>

        <div>
          <h2 className="mb-2 text-xl font-medium">Something went wrong</h2>
          <p className="text-muted-foreground text-sm">
            An unexpected error occurred. Please try again.
          </p>

          {process.env.NODE_ENV === 'development' && error.message && (
            <div className="border-border bg-surface-container mt-4 rounded-lg border p-4 text-left">
              <p className="text-destructive font-mono text-xs">{error.message}</p>
            </div>
          )}
        </div>

        <div className="flex gap-4">
          <Button onClick={reset}>Try again</Button>
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination -- error boundary からの復旧は状態を完全にリセットするためハードリロードが意図的 */}
          <Button onClick={() => (window.location.href = '/')} variant="outline">
            Go to Home
          </Button>
        </div>

        <p className="text-muted-foreground text-xs">Try again or reload the page.</p>
      </Card>
    </div>
  );
}
