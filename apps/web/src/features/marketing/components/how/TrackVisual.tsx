/**
 * TrackVisual — Plan vs Actual のオーバーラップバー
 */
export function TrackVisual() {
  const rows = [
    {
      label: 'Deep Work',
      planW: '85%',
      planT: '5h planned',
      actualW: '60%',
      actualT: '3.5h actual',
      delta: '−1.5h',
      deltaType: 'neg' as const,
    },
    {
      label: 'Meetings',
      planW: '15%',
      planT: '30m',
      actualW: '35%',
      actualT: '1.5h',
      delta: '+1h',
      deltaType: 'neg' as const,
    },
    {
      label: 'Rest',
      planW: '22%',
      planT: '1h',
      actualW: '22%',
      actualT: '1h',
      delta: '±0',
      deltaType: 'zero' as const,
    },
  ];

  const deltaColor = {
    neg: 'text-destructive',
    pos: 'text-success',
    zero: 'text-muted-foreground',
  };

  return (
    <div className="flex size-full items-center justify-center p-6" aria-hidden="true">
      <div className="flex w-full max-w-[260px] flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-[10px]">{row.label}</span>
            <div
              className="bg-primary/20 text-primary-text flex h-4 items-center rounded-[2px] px-1.5 text-[9px] font-medium"
              style={{ width: row.planW }}
            >
              {row.planT}
            </div>
            <div
              className="border-success/30 bg-success/12 text-success flex h-4 items-center rounded-[2px] border border-dashed px-1.5 text-[9px] font-medium"
              style={{ width: row.actualW }}
            >
              {row.actualT}
            </div>
            <span className={`text-[10px] font-medium ${deltaColor[row.deltaType]}`}>
              {row.delta}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
