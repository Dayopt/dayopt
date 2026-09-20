/**
 * ルートレベル Error ページ
 *
 * Route Group外でエラーが発生した場合に表示。
 * NextIntlClientProviderが利用できないため、静的英語テキストを使用。
 * global-error.tsx と統一されたカード型デザイン + Sentry連携。
 */
'use client';

import { useEffect } from 'react';

import { Button, Card } from '@dayopt/components';

import { attemptChunkLoadRecovery } from '@/lib/pwa/chunk-load-recovery';
import { captureClientBoundaryError } from '@/lib/sentry';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const ERROR_TEXT = {
  title: 'Something went wrong',
  description: 'We apologize for the inconvenience. An unexpected error occurred.',
  errorId: 'Error ID',
  showDetails: 'Show details',
  retry: 'Try again',
  goHome: 'Go to Home',
  recoveryHint: 'Try again or reload the page.',
};

export default function RootError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // リロードで解消する一過性なので 1 回目は capture しない。2 回目は通常どおり capture される。
    if (attemptChunkLoadRecovery(error)) {
      return;
    }
    captureClientBoundaryError(error, {
      feature: 'root',
      operation: 'render',
      route: window.location.pathname,
      source: 'root_error_boundary',
    });
  }, [error]);

  return (
    <div className="bg-background fixed inset-0 flex items-center justify-center overflow-auto p-4">
      <Card className="border-border-subtle bg-card w-full max-w-md gap-0 rounded-2xl p-8 py-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-destructive mb-2 text-2xl font-medium">{ERROR_TEXT.title}</h1>
          <p className="text-muted-foreground">{ERROR_TEXT.description}</p>
        </div>

        {error.digest && (
          <div className="bg-surface-container mb-4 rounded-lg p-4 text-xs">
            <p className="text-muted-foreground">
              {ERROR_TEXT.errorId}: <code className="font-mono">{error.digest}</code>
            </p>
          </div>
        )}

        {process.env.NODE_ENV === 'development' && (
          <details className="mb-6">
            <summary className="text-muted-foreground hover:bg-state-hover -mx-1 cursor-pointer rounded-lg px-1 text-sm transition-colors">
              {ERROR_TEXT.showDetails}
            </summary>
            <div className="bg-surface-container mt-4 rounded-lg p-4">
              <p className="mb-2 text-xs font-medium">{error.name}</p>
              <pre className="text-muted-foreground max-h-40 overflow-auto text-xs">
                {error.message}
              </pre>
            </div>
          </details>
        )}

        <div className="space-y-4">
          <Button onClick={reset} className="w-full">
            {ERROR_TEXT.retry}
          </Button>

          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination -- error boundary からの復旧は状態を完全にリセットするためハードリロードが意図的 */}
          <Button variant="outline" onClick={() => (window.location.href = '/')} className="w-full">
            {ERROR_TEXT.goHome}
          </Button>
        </div>

        <p className="text-muted-foreground mt-6 text-center text-xs">{ERROR_TEXT.recoveryHint}</p>
      </Card>
    </div>
  );
}
