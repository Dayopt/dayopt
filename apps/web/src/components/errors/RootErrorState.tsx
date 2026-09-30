'use client';

import { Button } from '@dayopt/components';
import Link from 'next/link';

import { ErrorLayout } from './ErrorLayout';

export interface RootErrorStateProps {
  error: Error & { digest?: string };
  onRetry: () => void;
  showDetails?: boolean;
}

/** Root error presentation without the boundary's Sentry capture side effect. */
export function RootErrorState({ error, onRetry, showDetails = false }: RootErrorStateProps) {
  return (
    <ErrorLayout
      title="Something went wrong"
      description="We encountered an unexpected error. Please try again or contact support if the problem persists."
      showBackButton={false}
    >
      <div className="mt-12 space-y-4">
        <Button onClick={onRetry} className="w-full sm:w-auto">
          Try again
        </Button>

        <Button variant="outline" asChild className="w-full sm:ml-4 sm:w-auto">
          <Link href="/">Go home</Link>
        </Button>
      </div>

      {showDetails && (
        <details className="mt-8">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
            Error details (dev only)
          </summary>
          <pre className="bg-muted text-destructive mt-2 overflow-auto rounded-lg p-4 text-xs">
            {error.message}
            {error.stack && (
              <>
                {'\n\n'}
                {error.stack}
              </>
            )}
          </pre>
        </details>
      )}
    </ErrorLayout>
  );
}
