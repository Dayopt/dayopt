'use client';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';

import { useCallback, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useActivityTree } from '@/features/activities';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from '@dayopt/components';

interface SegmentEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ダイアログ見出しと送信ボタンの文言（作成 / 編集で出し分ける） */
  title: string;
  /** 新規作成時は空文字列。編集時は既存名 */
  initialName?: string;
  initialActivityIds?: readonly string[];
  isSubmitting: boolean;
  onSubmit: (input: { name: string; activityIds: string[] }) => Promise<void>;
}

/**
 * セグメント作成・編集のダイアログ（#2181 Step 5、2026-09-07 に popover から差し替え）。
 *
 * 器はカレンダーのカテゴリー作成（`CategoryCreateDialog`）と同じ、画面中央に出す
 * `modal={false}` の Dialog（背景は暗転させない）。サイドバーの作成導線が面によって
 * 別物にならないよう揃える（2026-09-07 User 指示）。
 *
 * **制御された Dialog**にしてある。⋯ メニューの「アクティビティを編集」から開く経路が
 * あり、`DropdownMenuContent` の中に Dialog を置くとメニューを閉じる時のフォーカス戻しと
 * 開閉が競合するため、開閉の真実は呼び出し側（`SegmentList`）が 1 つだけ持つ。
 *
 * 保存させるのはアクティビティの集合だけ（#2162 §6-4）。期間・指標・グルーピングは
 * 持たせない — このダイアログに期間ピッカーやグルーピング選択を足さないこと自体が歯止め。
 */
export function SegmentEditDialog({
  open,
  onOpenChange,
  title,
  initialName = '',
  initialActivityIds = [],
  isSubmitting,
  onSubmit,
}: SegmentEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* フォームは閉じている間マウントしない。開くたびに初期値から組み直されるので、
            編集対象を切り替えて開き直しても前回の名前・選択が残らない（effect で
            state を積み直すのは cascading render になるため取らない） */}
        <SegmentEditForm
          title={title}
          initialName={initialName}
          initialActivityIds={initialActivityIds}
          isSubmitting={isSubmitting}
          onSubmit={onSubmit}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface SegmentEditFormProps {
  title: string;
  initialName: string;
  initialActivityIds: readonly string[];
  isSubmitting: boolean;
  onSubmit: (input: { name: string; activityIds: string[] }) => Promise<void>;
  onClose: () => void;
}

function SegmentEditForm({
  title,
  initialName,
  initialActivityIds,
  isSubmitting,
  onSubmit,
  onClose,
}: SegmentEditFormProps) {
  const { canUseProduct } = useBillingAccess();
  const t = useTranslations('calendar.stats.review.segments');
  const [name, setName] = useState(initialName);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialActivityIds));
  const { data: tree } = useActivityTree();

  const toggleActivity = useCallback((activityId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(activityId)) next.delete(activityId);
      else next.add(activityId);
      return next;
    });
  }, []);

  const trimmedName = name.trim();
  const canSubmit =
    canUseProduct && trimmedName.length > 0 && selectedIds.size > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      await onSubmit({ name: trimmedName, activityIds: [...selectedIds] });
      onClose();
    } catch {
      // Mutation hooks show the error and roll back optimistic state; retain form input.
    }
  }, [canSubmit, onSubmit, onClose, selectedIds, trimmedName]);

  const categoryGroups = useMemo(() => tree?.categories ?? [], [tree]);
  const uncategorized = tree?.uncategorized ?? [];

  return (
    <form
      className="flex flex-col gap-3 px-4 pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('namePlaceholder')}
        aria-label={t('title')}
      />
      <ScrollArea className="h-48 rounded-lg border">
        <div className="flex flex-col gap-1 p-2">
          {categoryGroups.map((group) => (
            <div key={group.category.id} className="flex flex-col gap-1">
              <p className="text-muted-foreground px-1 pt-1 text-xs font-medium">
                {group.category.name}
              </p>
              {group.activities.map((activity) => (
                <label
                  key={activity.id}
                  className="hover:bg-state-hover flex min-h-9 items-center gap-2 rounded-lg px-1 text-sm"
                >
                  <Checkbox
                    checked={selectedIds.has(activity.id)}
                    onCheckedChange={() => toggleActivity(activity.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{activity.name}</span>
                </label>
              ))}
            </div>
          ))}
          {uncategorized.map((activity) => (
            <label
              key={activity.id}
              className="hover:bg-state-hover flex min-h-9 items-center gap-2 rounded-lg px-1 text-sm"
            >
              <Checkbox
                checked={selectedIds.has(activity.id)}
                onCheckedChange={() => toggleActivity(activity.id)}
              />
              <span className="min-w-0 flex-1 truncate">{activity.name}</span>
            </label>
          ))}
        </div>
      </ScrollArea>
      <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} className="self-end">
        {title}
      </Button>
    </form>
  );
}
