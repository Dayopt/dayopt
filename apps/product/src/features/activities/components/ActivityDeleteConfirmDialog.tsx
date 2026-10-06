'use client';

import { useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';

interface ActivityDeleteConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  /**
   * 'activity' = アクティビティ削除（参照する予定・記録が「アクティビティなし」になる）
   * 'category' = カテゴリー削除（所属アクティビティが未分類になる。予定・記録は変わらない）
   */
  kind: 'activity' | 'category';
  name: string;
  /** kind='activity' なら関連する予定・記録の件数、kind='category' なら所属アクティビティの件数 */
  affectedCount: number | null;
}

/**
 * アクティビティ / カテゴリー完全削除の確認ダイアログ
 *
 * どちらも削除しても関連レコードは削除されない（アクティビティ削除は予定・記録が
 * 「アクティビティなし」になり、カテゴリー削除は所属アクティビティが未分類になる）。
 * 2 つは意味が違うため、`kind` で説明文を出し分ける。
 *
 * 影響が 0 件でも省略せず必ず出す（2026-09-04 User 指示）。削除は不可逆なので、
 * 件数の有無ではなく操作の不可逆性そのものを確認の理由にする。0 件の時は
 * 「〜件は削除されません」が空回りするため、専用の文言へ切り替える。
 */
export function ActivityDeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  kind,
  name,
  affectedCount,
}: ActivityDeleteConfirmDialogProps) {
  const t = useTranslations('activities');

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('delete.confirmTitle', { name })}
      description={t(
        affectedCount === null
          ? kind === 'activity'
            ? 'delete.activityDescriptionUnknown'
            : 'delete.categoryDescriptionUnknown'
          : affectedCount === 0
            ? kind === 'activity'
              ? 'delete.activityDescriptionEmpty'
              : 'delete.categoryDescriptionEmpty'
            : kind === 'activity'
              ? 'delete.activityDescription'
              : 'delete.categoryDescription',
        { count: affectedCount ?? 0 },
      )}
      variant="destructive"
      confirmLabel={t('delete.confirmButton')}
    />
  );
}
