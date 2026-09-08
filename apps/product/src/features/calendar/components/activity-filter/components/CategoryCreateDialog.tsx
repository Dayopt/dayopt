'use client';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';

import { useCallback, useState } from 'react';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CategoryAppearancePickerRow, useCreateCategory } from '@/features/activities';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  HoverTooltip,
  Input,
} from '@dayopt/components';

import type { CategoryColorName } from '@/features/activities';

/**
 * サイドバー「カテゴリ」見出しのカテゴリー直接作成ボタン（#2211、#2406 で属性行を追加）。
 *
 * 中身はアクティビティ作成と同じ、画面中央に出す `modal={false}` の Dialog
 * （背景は暗転させない。2026-09-03 User 指示）。
 *
 * 「未分類」見出しの `+`（アクティビティ作成）と対称の配置・挙動 —
 * hover/focus 時だけ表示する。名前 Input に加え、色・アイコンの属性行
 * （`CategoryAppearancePickerRow`）を表示する。色・アイコンは未選択のままでも
 * 送信でき、その場合は `useCreateCategory` の既存デフォルトに従う（#2162 §4-6
 * 「色・アイコンはカテゴリーだけが持つ」モデルは変えない）ので、最小経路
 * （名前入力 → Enter）は 2 手のまま。
 */
interface CategoryCreateDialogProps {
  /** ダイアログの開閉を親へ通知する（見出しの hover-reveal を強制表示するため） */
  onOpenChange?: (open: boolean) => void;
}

export function CategoryCreateDialog({ onOpenChange }: CategoryCreateDialogProps = {}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<CategoryColorName | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const createCategoryMutation = useCreateCategory();

  const trimmedName = name.trim();
  const submitting = createCategoryMutation.isPending;
  const { canUseProduct } = useBillingAccess();
  const canSubmit = canUseProduct && trimmedName.length > 0 && !submitting;

  const resetForm = useCallback(() => {
    setName('');
    setColor(null);
    setIcon(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
      if (!next) resetForm();
    },
    [onOpenChange, resetForm],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      await createCategoryMutation.mutateAsync({
        name: trimmedName,
        ...(color ? { color } : {}),
        ...(icon ? { icon } : {}),
      });
      resetForm();
      handleOpenChange(false);
    } catch {
      // mutation hook 側で toast 済み。ダイアログは開いたまま
    }
  }, [canSubmit, createCategoryMutation, trimmedName, color, icon, resetForm, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
      <HoverTooltip content={t('calendar.filter.createCategory')} side="top">
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            icon
            // 未分類の歯車と同じく、開いている間は hover 状態を維持する
            className={cn('size-6', open && 'bg-state-hover')}
            aria-label={t('calendar.filter.createCategory')}
          >
            <Plus className="size-4" />
          </Button>
        </DialogTrigger>
      </HoverTooltip>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('calendar.filter.createCategory')}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 px-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <CategoryAppearancePickerRow
            color={color}
            onColorChange={setColor}
            icon={icon}
            onIconChange={setIcon}
          />
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('calendar.filter.createDialog.categoryNamePlaceholder')}
            aria-label={t('calendar.filter.createCategory')}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            className="self-end"
          >
            {t('calendar.filter.createCategory')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
