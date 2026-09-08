'use client';

import type { ReactNode } from 'react';

import { cn } from '@dayopt/components';

interface SectionCardProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}

/**
 * 設定セクションコンポーネント
 *
 * セクション間はborder-bセパレータで区切るフラットスタイル。
 * 現在は主に Settings の設定系UIで使用。
 */
export function SectionCard({ title, children, className, actions }: SectionCardProps) {
  return (
    <section
      className={cn('border-border text-foreground border-b pb-6 last:border-b-0', className)}
    >
      {(title || actions) && (
        <div className="mb-2 flex items-center justify-between gap-4">
          {title ? <h2 className="text-foreground text-sm font-medium">{title}</h2> : <div />}
          {actions ? <div className="flex flex-shrink-0 items-center gap-4">{actions}</div> : null}
        </div>
      )}
      <div className="text-base">{children}</div>
    </section>
  );
}
