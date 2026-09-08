'use client';

/**
 * カテゴリーリネームモーダル
 *
 * `useShellStore.activeSheet` で管理され、どこからでも
 * `useShellStore.use.openCategoryRenameModal(category)` で開ける。
 * 名前だけを変更する軽量フォーム（色・アイコンの変更はサイドバーの
 * カテゴリーメニューが担当するので、ここには置かない）。
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

import { useCategories } from '../hooks/useActivitiesQuery';
import { useUpdateCategory } from '../hooks/useCategoryMutations';
import { ACTIVITY_NAME_MAX_LENGTH } from '../lib/category-colors';

import type { CategoryRenameTarget } from '@/lib/stores/useShellStore';

interface CategoryRenameModalProps {
  open: boolean;
  onClose: () => void;
  category: CategoryRenameTarget;
}

export function CategoryRenameModal({ open, onClose, category }: CategoryRenameModalProps) {
  const formKey = open ? `${category.id}:${category.name}` : 'closed';

  return (
    <CategoryRenameModalForm key={formKey} open={open} onClose={onClose} category={category} />
  );
}

function CategoryRenameModalForm({ open, onClose, category }: CategoryRenameModalProps) {
  const t = useTranslations('calendar.filter.renamePopover');
  const tCommon = useTranslations('common');

  const { data: existingCategories } = useCategories();
  const updateCategoryMutation = useUpdateCategory();

  const { canUseProduct } = useBillingAccess();
  const [name, setName] = useState(category.name);
  const [debouncedName, setDebouncedName] = useState(category.name);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedName(name), 200);
    return () => clearTimeout(id);
  }, [name]);

  const trimmedDebounced = debouncedName.trim();

  // カテゴリーに階層は無いので、名前の重複は全カテゴリー横断でチェックする
  const duplicate = useMemo(() => {
    if (!trimmedDebounced) return false;
    const lower = trimmedDebounced.toLowerCase();
    return (existingCategories ?? []).some(
      (other) => other.id !== category.id && other.name.toLowerCase() === lower,
    );
  }, [existingCategories, category.id, trimmedDebounced]);

  const trimmedLive = name.trim();
  const unchanged = trimmedLive === category.name;
  const canSubmit =
    canUseProduct && trimmedLive.length > 0 && !duplicate && !unchanged && !submitting;

  const errorMessage = duplicate ? t('duplicateName') : null;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await updateCategoryMutation.mutateAsync({ id: category.id, name: trimmedLive });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, updateCategoryMutation, category.id, trimmedLive, onClose]);

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
      // アクティビティの作成 / 改名と同じく背景を暗転させない（2026-09-03 User 指示）
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
