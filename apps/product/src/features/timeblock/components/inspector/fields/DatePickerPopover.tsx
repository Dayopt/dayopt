'use client';

/**
 * 日付選択ポップオーバー（共通コンポーネント）
 *
 * Plan/Record共通で使用する日付選択UI
 * PC: Popover / モバイル: Drawer
 */

import { useState } from 'react';

import { Calendar } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { MiniCalendar } from '@/components/ui/inputs/mini-calendar';
import { useDateFormat } from '@/lib/hooks/useDateFormat';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { Drawer, DrawerContent, DrawerTitle } from '@dayopt/components';

interface DatePickerPopoverProps {
  selectedDate: Date | undefined;
  onDateChange: (date: Date | undefined) => void;
  placeholder?: string;
  className?: string;
  /** Popover の z-index クラス名（デフォルト: 'z-overlay-popover'） */
  popoverZIndex?: string;
  /** アイコンを表示するか（デフォルト: false） */
  showIcon?: boolean;
  /** 無効化（opacity低下 + pointer-events-none） */
  disabled?: boolean;
  /** 選択可能な最小日付 */
  minDate?: Date | undefined;
}

/**
 * DatePickerPopover - MiniCalendar のラッパー
 *
 * **機能**:
 * - ボタンクリックでカレンダー表示（PC: Popover / モバイル: Drawer）
 * - 日付選択後に自動的に閉じる
 * - 月/年のドロップダウン選択対応
 */
export function DatePickerPopover({
  selectedDate,
  onDateChange,
  placeholder,
  popoverZIndex = 'z-overlay-popover',
  showIcon = false,
  disabled = false,
  minDate,
}: DatePickerPopoverProps) {
  const t = useTranslations();
  const { formatDate } = useDateFormat();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const resolvedPlaceholder = placeholder ?? t('common.datePicker.placeholder');

  const triggerButton = (
    <button
      type="button"
      disabled={disabled}
      className="text-muted-foreground data-[state=selected]:text-foreground hover:bg-state-hover focus-visible:ring-ring inline-flex h-8 items-center gap-2 rounded-lg px-2 text-base tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      data-state={selectedDate ? 'selected' : undefined}
      aria-label={
        selectedDate
          ? t('common.datePicker.selectLabel', { date: formatDate(selectedDate) })
          : t('common.datePicker.notSelected')
      }
      onClick={isMobile ? () => setDrawerOpen(true) : undefined}
    >
      {showIcon && <Calendar className="size-4" />}
      {selectedDate ? formatDate(selectedDate) : resolvedPlaceholder}
    </button>
  );

  // --- モバイル: Drawer ---
  if (isMobile) {
    return (
      <>
        {triggerButton}
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DrawerContent className="z-overlay-popover">
            <DrawerTitle className="sr-only">{resolvedPlaceholder}</DrawerTitle>
            <div className="pb-safe px-4">
              <MiniCalendar
                selectedDate={selectedDate}
                onDateSelect={(date) => {
                  onDateChange(date);
                  setDrawerOpen(false);
                }}
                minDate={minDate}
              />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  // --- PC: Popover ---
  return (
    <MiniCalendar
      asPopover
      popoverTrigger={triggerButton}
      selectedDate={selectedDate}
      onDateSelect={onDateChange}
      popoverAlign="end"
      popoverZIndex={popoverZIndex}
      minDate={minDate}
    />
  );
}
