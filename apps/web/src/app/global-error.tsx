'use client';

import { BoundaryRecovery } from '@web/components/errors/BoundaryRecovery';
import { isDevelopment } from '@web/platform/config/runtime-env';
import { captureBoundaryError } from '@web/platform/observability/capture-boundary-error';
import { lazy, Suspense, useEffect } from 'react';

const GlobalErrorPresentation = lazy(() =>
  import('@web/components/errors/GlobalErrorPresentation')
    .then((module) => ({ default: module.GlobalErrorPresentation }))
    .catch((error: unknown) => {
      if (error instanceof globalThis.Error) captureBoundaryError(error, 'global_error');
      return { default: BoundaryRecovery };
    }),
);

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    captureBoundaryError(error, 'global_error');
  }, [error]);

  return (
    <html>
      <body>
        <Suspense fallback={<BoundaryRecovery error={error} onRetry={reset} />}>
          <GlobalErrorPresentation error={error} onRetry={reset} showDetails={isDevelopment} />
        </Suspense>
      </body>
    </html>
  );
}
