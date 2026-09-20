/**
 * LearnVisual — 週次所見スニペット（予定と記録、パターン、見積もり傾向）
 */
export function LearnVisual() {
  return (
    <div className="flex size-full items-center justify-center p-4" aria-hidden="true">
      <div className="flex w-full max-w-[260px] flex-col gap-2">
        {/* Plan and Record */}
        <div className="border-border rounded-lg border bg-[var(--background)]/30 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <div className="bg-primary/15 flex size-5 items-center justify-center rounded-[4px] text-[10px]">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                className="text-primary"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M3 3v18h18" />
                <path d="M7 16l4-6 4 4 6-8" />
              </svg>
            </div>
            <span className="text-foreground text-[11px] font-medium">Plan and Record</span>
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col">
              <span className="text-primary-text text-base font-medium tabular-nums">22.5h</span>
              <span className="text-muted-foreground text-[9px]">Plan</span>
            </div>
            <div className="flex flex-col">
              <span className="text-success text-base font-medium tabular-nums">18h</span>
              <span className="text-muted-foreground text-[9px]">Record</span>
            </div>
            <div className="flex flex-col">
              <span className="text-destructive text-base font-medium tabular-nums">−4.5h</span>
              <span className="text-muted-foreground text-[9px]">Difference</span>
            </div>
          </div>
        </div>

        {/* Pattern */}
        <div className="border-border rounded-lg border bg-[var(--background)]/30 p-3">
          <div className="mb-1 flex items-center gap-2">
            <div className="bg-category-amber/15 flex size-5 items-center justify-center rounded-[4px] text-[10px]">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                className="text-category-amber"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <span className="text-foreground text-[11px] font-medium">Weekly pattern</span>
          </div>
          <p className="text-muted-foreground text-[10px] leading-relaxed">
            Deep work drops 40% on days with 2+ meetings.
          </p>
        </div>

        {/* Accuracy */}
        <div className="border-border rounded-lg border bg-[var(--background)]/30 p-3">
          <div className="mb-1 flex items-center gap-2">
            <div className="bg-success/15 flex size-5 items-center justify-center rounded-[4px] text-[10px]">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                className="text-success"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l2 2" />
              </svg>
            </div>
            <span className="text-foreground text-[11px] font-medium">Estimate fit: 61% → 74%</span>
          </div>
          <p className="text-muted-foreground text-[10px] leading-relaxed">
            Plan and Record are getting closer each week.
          </p>
        </div>
      </div>
    </div>
  );
}
