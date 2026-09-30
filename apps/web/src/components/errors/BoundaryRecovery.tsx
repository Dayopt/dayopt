import Link from 'next/link';
import type { RootErrorStateProps } from './RootErrorState';

/** Recovery remains usable while the detailed error view loads, or if its chunk fails. */
export function BoundaryRecovery({ onRetry }: RootErrorStateProps) {
  return (
    <main className="bg-background text-foreground grid min-h-screen place-content-center gap-6 p-6">
      <h1 className="text-2xl font-medium">Something went wrong</h1>
      <p>Please try again. If it continues, contact support.</p>
      <button
        className="bg-primary text-primary-foreground min-h-11 rounded-lg px-4 py-2"
        onClick={onRetry}
      >
        Try again
      </button>
      <Link className="min-h-11 underline" href="/" prefetch={false}>
        Go home
      </Link>
    </main>
  );
}
