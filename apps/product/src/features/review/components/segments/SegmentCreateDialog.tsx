'use client';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';

import { useCallback, useState } from 'react';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, cn, HoverTooltip } from '@dayopt/components';

import { useCreateSegment } from '../../hooks/useSegments';
import { SegmentEditDialog } from './SegmentEditDialog';

interface SegmentCreateDialogProps {
  /** ダイアログの開閉を親へ通知する（見出しの hover-reveal を強制表示するため） */
  onOpenChange?: (open: boolean) => void;
}

/**
 * サイドバー「セグメント」見出しの作成ボタン。
 *
 * カレンダーの「カテゴリ」見出しの `+`（`CategoryCreateDialog`）と同じ配置・同じ現れ方に
 * 揃える（2026-09-07 User 指示）— 見出しの action スロットに置き、hover / focus した時
 * だけ出す。開いている間は `bg-state-hover` を保ち、どのボタンから出ているダイアログか
 * 読めるようにする。
 */
export function SegmentCreateDialog({ onOpenChange }: SegmentCreateDialogProps = {}) {
  const { canUseProduct } = useBillingAccess();
  const t = useTranslations('calendar.stats.review.segments');
  const [open, setOpen] = useState(false);
  const createSegment = useCreateSegment();

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  return (
    <>
      <HoverTooltip content={t('create')} side="top">
        <Button
          type="button"
          disabled={!canUseProduct}
          variant="ghost"
          icon
          className={cn('size-6', open && 'bg-state-hover')}
          aria-label={t('create')}
          onClick={() => handleOpenChange(true)}
        >
          <Plus className="size-4" />
        </Button>
      </HoverTooltip>

      <SegmentEditDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('create')}
        isSubmitting={createSegment.isPending}
        onSubmit={async (input) => {
          await createSegment.mutateAsync(input);
        }}
      />
    </>
  );
}
