import { Button, Container, Heading, Text } from '@dayopt/components';
import Link from 'next/link';
import type { RootErrorStateProps } from './RootErrorState';

export function GlobalErrorPresentation({
  error,
  onRetry: reset,
  showDetails: isDevelopment = false,
}: RootErrorStateProps) {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <Container>
        <div className="mx-auto max-w-md text-center">
          <Heading as="h2" size="xl" className="mb-4">
            Something went wrong
          </Heading>

          <Text variant="muted" className="mb-8">
            An unexpected error occurred. Please try again. If it continues, contact support.
          </Text>

          <div className="space-y-4">
            <Button onClick={reset} className="w-full">
              Try again
            </Button>

            <Button variant="outline" className="w-full" asChild>
              <Link href="/" prefetch={false}>
                Go home
              </Link>
            </Button>
          </div>

          {/* Error details for development */}
          {isDevelopment && (
            <div className="bg-container mt-8 rounded-lg p-4 text-left">
              <Text size="sm" variant="muted" className="mb-2 block">
                Development Error Details:
              </Text>
              <pre className="text-destructive overflow-auto text-xs">{error.message}</pre>
              {error.digest && (
                <Text size="xs" variant="muted" className="mt-2 block">
                  Error ID: {error.digest}
                </Text>
              )}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
