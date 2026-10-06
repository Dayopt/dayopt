'use client';

import { BoundaryRecovery } from '@web/components/errors/BoundaryRecovery';
import { isDevelopment } from '@web/platform/config/runtime-env';
import { captureBoundaryError } from '@web/platform/observability/capture-boundary-error';
import { DocumentFrame } from '@web/shell/layout/DocumentFrame';
import { lazy, Suspense, useEffect } from 'react';

const RootErrorState = lazy(() =>
  import('@web/components/errors/RootErrorState')
    .then((module) => ({ default: module.RootErrorState }))
    .catch((error: unknown) => {
      if (error instanceof globalThis.Error) captureBoundaryError(error, 'root_error');
      return { default: BoundaryRecovery };
    }),
);

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureBoundaryError(error, 'root_error');
  }, [error]);

  return (
    <DocumentFrame>
      <Suspense fallback={<BoundaryRecovery error={error} onRetry={reset} />}>
        <RootErrorState error={error} onRetry={reset} showDetails={isDevelopment} />
      </Suspense>
    </DocumentFrame>
  );
}
