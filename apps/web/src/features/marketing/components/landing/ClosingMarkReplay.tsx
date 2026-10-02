'use client';

import { type ReactNode, useEffect, useState } from 'react';

export function ClosingMarkReplay({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [replay, setReplay] = useState(0);
  useEffect(() => setReady(true), []);

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      disabled={!ready}
      onClick={() => setReplay((count) => count + 1)}
    >
      <span key={replay}>{children}</span>
    </button>
  );
}
