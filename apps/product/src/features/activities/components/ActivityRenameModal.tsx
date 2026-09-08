'use client';

/**
 * アクティビティリネームモーダル
 *
 * `useShellStore.activeSheet` で管理され、どこからでも
 * `useShellStore.use.openActivityRenameModal(activity)` で開ける。
 * 名前だけを変更する軽量フォーム（所属カテゴリーの付け替えは行メニューの
 * 「カテゴリーを変更」が担当するので、ここには置かない）。
 */

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldError,
  Input,
} from '@dayopt/components';

import { useActivities } from '../hooks/useActivitiesQuery';
import { useUpdateActivity } from '../hooks/useActivityMutations';
import { ACTIVITY_NAME_MAX_LENGTH } from '../lib/category-colors';

import type { ActivityRenameTarget } from '@/lib/stores/useShellStore';

interface ActivityRenameModalProps {
  open: boolean;
  onClose: () => void;
  activity: ActivityRenameTarget;
}

export function ActivityRenameModal({ open, onClose, activity }: ActivityRenameModalProps) {
  const formKey = open ? `${activity.id}:${activity.name}` : 'closed';

  return (
    <ActivityRenameModalForm key={formKey} open={open} onClose={onClose} activity={activity} />
  );
}

function ActivityRenameModalForm({ open, onClose, activity }: ActivityRenameModalProps) {
  const t = useTranslations('calendar.filter.renamePopover');
  const tCommon = useTranslations('common');

  const { data: existingActivities } = useActivities();
  const updateActivityMutation = useUpdateActivity();

  const { canUseProduct } = useBillingAccess();
  const [name, setName] = useState(activity.name);
  const [debouncedName, setDebouncedName] = useState(activity.name);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedName(name), 200);
    return () => clearTimeout(id);
  }, [name]);

  const trimmedDebounced = debouncedName.trim();

  // ActivityRenameTarget は id/name しか持たないので、重複チェックに使う
  // category_id は現在の一覧から引く（見つからなければ未分類扱い）
  const currentCategoryId = useMemo(
    () => existingActivities?.find((other) => other.id === activity.id)?.category_id ?? null,
    [existingActivities, activity.id],
  );

  const duplicate = useMemo(() => {
    if (!trimmedDebounced) return false;
    const lower = trimmedDebounced.toLowerCase();
    return (existingActivities ?? []).some(
      (other) =>
        other.id !== activity.id &&
        (other.category_id ?? null) === currentCategoryId &&
        other.name.toLowerCase() === lower,
    );
  }, [existingActivities, activity.id, currentCategoryId, trimmedDebounced]);

  const trimmedLive = name.trim();
  const unchanged = trimmedLive === activity.name;
  const canSubmit =
    canUseProduct && trimmedLive.length > 0 && !duplicate && !unchanged && !submitting;

  const errorMessage = duplicate ? t('duplicateName') : null;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await updateActivityMutation.mutateAsync({ id: activity.id, name: trimmedLive });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, updateActivityMutation, activity.id, trimmedLive, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!canSubmit) return;
        void handleSubmit();
      }
    },
    [canSubmit, handleSubmit],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      // 背景を暗転させない軽いポップアップにする（2026-09-03 User 指示）。
      // 位置は中央のまま。モバイルの Drawer は常に modal なので影響しない
      modal={false}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1 px-4">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('namePlaceholder')}
            aria-label={t('name')}
            aria-invalid={duplicate || undefined}
            maxLength={ACTIVITY_NAME_MAX_LENGTH}
            disabled={submitting}
          />
          {errorMessage ? <FieldError announceImmediately>{errorMessage}</FieldError> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            loading={submitting}
          >
            {tCommon('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
