import { GitCompareArrows } from 'lucide-react';

/** Compare panel に表示中の timeblock であることをカード上に示す。 */
export function DayDiffMarker() {
  return (
    <span
      data-timeblock-day-diff-marker
      className="bg-background text-muted-foreground border-border-subtle pointer-events-none absolute top-1 right-1 flex size-5 items-center justify-center rounded-full border shadow-sm"
      aria-hidden="true"
    >
      <GitCompareArrows className="size-3.5" />
    </span>
  );
}
