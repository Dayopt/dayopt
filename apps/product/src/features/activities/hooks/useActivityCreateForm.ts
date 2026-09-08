'use client';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { CreatedActivityPayload } from '@/lib/stores/useShellStore';

import type { Activity, Category } from '../types';
import { useActivities, useCategories } from './useActivitiesQuery';
import { useCreateActivity } from './useActivityMutations';

interface UseActivityCreateFormOptions {
  /** フォームが開いているか。閉→開の遷移で入力を初期化する */
  open: boolean;
  initialCategoryId: string | null;
  /** 作成成功時に呼ばれる（selection 反映等） */
  onCreated?: ((activity: CreatedActivityPayload) => void) | undefined;
  /** 作成成功時に入れ物（Dialog / Popover）を閉じる */
  onClose: () => void;
}

/**
 * アクティビティ新規作成フォームの state と検証。
 *
 * 入れ物（PC サイドバーの Popover / モバイルの Dialog・Drawer）が 2 つあるため、
 * 同名判定と作成 mutation はここへ寄せる。片方だけ直る事故を防ぐ。
 */
export function useActivityCreateForm({
  open,
  initialCategoryId,
  onCreated,
  onClose,
}: UseActivityCreateFormOptions) {
  const { canUseProduct } = useBillingAccess();
  const t = useTranslations('calendar.filter.createDialog');

  const { data: existingActivities } = useActivities();
  const { data: categories } = useCategories();
  const createActivityMutation = useCreateActivity();

  const [name, setName] = useState('');
  const [debouncedName, setDebouncedName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(initialCategoryId);
  const [submitting, setSubmitting] = useState(false);

  // open 時に初期値を同期
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setName('');
      setDebouncedName('');
      setCategoryId(initialCategoryId);
      setSubmitting(false);
    });
  }, [open, initialCategoryId]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedName(name), 200);
    return () => clearTimeout(id);
  }, [name]);

  const categoryOptions = useMemo<Category[]>(
    () => (categories ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  );

  const activeActivities = useMemo<Activity[]>(
    () => existingActivities ?? [],
    [existingActivities],
  );

  const trimmedDebounced = debouncedName.trim();
  const trimmedLive = name.trim();

  const checkDuplicate = useCallback(
    (value: string) => {
      if (!value) return false;
      const lower = value.toLowerCase();
      return activeActivities.some(
        (activity) => activity.category_id === categoryId && activity.name.toLowerCase() === lower,
      );
    },
    [activeActivities, categoryId],
  );

  const duplicate = useMemo(
    () => checkDuplicate(trimmedDebounced),
    [checkDuplicate, trimmedDebounced],
  );

  const canSubmit = canUseProduct && trimmedLive.length > 0 && !duplicate && !submitting;

  const errorMessage = duplicate ? t('duplicateName') : null;

  const handleSubmit = useCallback(async () => {
    if (submitting || trimmedLive.length === 0) return;
    // debounce (200ms) より早く submit された場合に備え、live name で同期再チェック
    if (checkDuplicate(trimmedLive)) {
      setDebouncedName(trimmedLive);
      return;
    }
    setSubmitting(true);
    try {
      const created = await createActivityMutation.mutateAsync({
        name: trimmedLive,
        categoryId,
      });
      onCreated?.({
        id: created.id,
        name: created.name,
        categoryId: created.category_id,
      });
      onClose();
    } catch {
      // mutation hook 側で toast 済み。閉じない
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    trimmedLive,
    checkDuplicate,
    createActivityMutation,
    categoryId,
    onCreated,
    onClose,
  ]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!canSubmit) return;
        void handleSubmit();
      }
    },
    [canSubmit, handleSubmit],
  );

  return {
    name,
    setName,
    categoryId,
    setCategoryId,
    categoryOptions,
    duplicate,
    errorMessage,
    canSubmit,
    submitting,
    handleSubmit,
    handleNameKeyDown,
  };
}
