'use client';

/**
 * Global Error Handler - Sentry統合
 *
 * Next.js App Router のグローバルエラーハンドラー
 * Root Layout 自体が壊れた時に発動するため、独自の <html><body> を持つ。
 *
 * 重要:
 * - Root Layout が描画されないため、Tailwind CSS変数が利用不可の場合がある
 * - <style> タグでデザインシステムのOKLCHトークン相当のCSS変数を定義
 * - NextIntlClientProvider が利用不可のため静的英語テキストを使用
 */

import { useEffect } from 'react';

import { attemptChunkLoadRecovery } from '@/lib/pwa/chunk-load-recovery';
import { captureClientBoundaryError } from '@/lib/sentry';

import { createGlobalErrorActions } from './_global-error/actions';
import { ErrorButton } from './_global-error/ErrorButton';
import { buildFailureContext } from './_global-error/failure';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // リロードで解消する一過性なので 1 回目は capture しない。2 回目は通常どおり capture される。
    if (attemptChunkLoadRecovery(error)) {
      return;
    }
    captureClientBoundaryError(error, {
      feature: 'root_layout',
      operation: 'render',
      route: window.location.pathname,
      source: 'global_error_boundary',
    });
  }, [error]);

  const failure = buildFailureContext(error);
  const actions = createGlobalErrorActions({ reset });

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: failure.fallbackStyles }} />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: 'var(--ge-background)',
          color: 'var(--ge-foreground)',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            minHeight: '100vh',
            width: '100%',
            padding: '1rem',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '28rem',
              backgroundColor: 'var(--ge-card)',
              border: '1px solid var(--ge-border)',
              borderRadius: '1rem',
              padding: '2rem',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ marginBottom: '1.5rem' }}>
              <h1
                style={{
                  color: 'var(--ge-destructive)',
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  marginTop: 0,
                  marginBottom: '0.5rem',
                }}
              >
                {failure.title}
              </h1>
              <p style={{ color: 'var(--ge-muted)', margin: 0, lineHeight: 1.5 }}>
                {failure.description}
              </p>
            </div>

            {failure.errorDigest && (
              <div
                style={{
                  backgroundColor: 'var(--ge-card-inset)',
                  borderRadius: '0.375rem',
                  padding: '1rem',
                  marginBottom: '1rem',
                  fontSize: '0.75rem',
                }}
              >
                <p style={{ color: 'var(--ge-muted)', margin: 0 }}>
                  {failure.errorIdLabel}:{' '}
                  <code style={{ fontFamily: 'monospace' }}>{failure.errorDigest}</code>
                </p>
              </div>
            )}

            {failure.shouldShowDetails && (
              <details style={{ marginBottom: '1.5rem' }}>
                <summary
                  style={{
                    color: 'var(--ge-muted)',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                    padding: '0.25rem',
                  }}
                >
                  {failure.showDetailsLabel}
                </summary>
                <div
                  style={{
                    backgroundColor: 'var(--ge-card-inset)',
                    borderRadius: '0.375rem',
                    padding: '1rem',
                    marginTop: '1rem',
                  }}
                >
                  <p style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    {failure.errorName}
                  </p>
                  <pre
                    style={{
                      color: 'var(--ge-muted)',
                      fontSize: '0.75rem',
                      maxHeight: '10rem',
                      overflow: 'auto',
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {failure.errorMessage}
                  </pre>
                </div>
              </details>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <ErrorButton onClick={actions.retry}>{failure.retryLabel}</ErrorButton>
              <ErrorButton variant="outline" onClick={actions.goHome}>
                {failure.goHomeLabel}
              </ErrorButton>
            </div>

            <p
              style={{
                color: 'var(--ge-muted)',
                fontSize: '0.75rem',
                textAlign: 'center',
                marginTop: '1.5rem',
                marginBottom: 0,
              }}
            >
              {failure.recoveryHint}
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
