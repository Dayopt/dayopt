'use client';

import { useState, type ReactNode } from 'react';

import { Button, FloatingActionBar, FloatingActionBarItem } from '@dayopt/components';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useTimeblockRecordMutations } from '../../hooks/useTimeblockRecordMutations';

/** ブロック下の操作を、余白を持たせたカプセル状のバーにまとめる。 */
export function TimeblockRecordActions({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1">
      <FloatingActionBar className="mx-auto">{children}</FloatingActionBar>
    </div>
  );
}

interface RecordPlanButtonProps {
  planId: string;
  beforeRecord: () => Promise<string>;
  onPreparingChange?: ((isPreparing: boolean) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onRecorded?: ((recordId: string) => void) | undefined;
  disabled?: boolean | undefined;
}

/** 過去 Plan を同じ時間帯の Record として記録するワンタップ導線。 */
export function RecordPlanButton({
  planId,
  beforeRecord,
  onPreparingChange,
  onError,
  onRecorded,
  disabled = false,
}: RecordPlanButtonProps) {
  const t = useTranslations('timeblock.editor');
  const { recordPlan } = useTimeblockRecordMutations();
  const [isPreparing, setIsPreparing] = useState(false);
  const isPending = isPreparing || recordPlan.isPending;

  const handleRecord = () => {
    if (disabled || isPending) return;
    setIsPreparing(true);
    onPreparingChange?.(true);
    void beforeRecord().then(
      (expectedUpdatedAt) => {
        recordPlan.mutate(
          { id: planId, expectedUpdatedAt },
          {
            onSuccess: (record) => onRecorded?.(record.id),
            ...(onError ? { onError } : {}),
            onSettled: () => {
              setIsPreparing(false);
              onPreparingChange?.(false);
            },
          },
        );
      },
      (error: unknown) => {
        onError?.(error);
        setIsPreparing(false);
        onPreparingChange?.(false);
      },
    );
  };

  return (
    <FloatingActionBarItem
      type="button"
      className="flex-row gap-2 text-sm"
      onClick={handleRecord}
      disabled={disabled || isPending}
      aria-busy={isPending}
    >
      <Check className="size-4" aria-hidden="true" />
      {t('recordAsIs')}
    </FloatingActionBarItem>
  );
}

interface ConfirmDayButtonProps {
  startAt: Date;
  endAt: Date;
  disabled?: boolean | undefined;
}

/** 日ヘッダーに置く、一日の未記録 Plan をまとめて記録する導線。 */
export function ConfirmDayButton({ startAt, endAt, disabled = false }: ConfirmDayButtonProps) {
  const t = useTranslations('timeblock.editor');
  const { confirmDay } = useTimeblockRecordMutations();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() =>
        confirmDay.mutate({ start_at: startAt.toISOString(), end_at: endAt.toISOString() })
      }
      disabled={disabled || confirmDay.isPending}
    >
      {t('confirmDay')}
    </Button>
  );
}
