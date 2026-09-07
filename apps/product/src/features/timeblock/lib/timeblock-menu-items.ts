/**
 * Timeblock に対する操作メニューの items 定義（単一情報源）
 *
 * 右クリックメニュー（EventContextMenu）と Inspector の TagRow メニューが
 * 同じ項目セット・同じ表示条件を共有するための shared source。
 *
 * shell（floating button / Radix DropdownMenu）は呼び出し側が自前で持つ。
 * この関数は「どの項目をどの条件で出すか」だけを担う。
 */

import type { LucideIcon } from 'lucide-react';
import { BarChart3, Copy, CopyPlus, Trash2 } from 'lucide-react';

import type { MessageKey } from '@/lib/i18n';

export type TimeblockMenuItemKey = 'viewStats' | 'copy' | 'duplicate' | 'delete';

export interface TimeblockMenuItem {
  key: TimeblockMenuItemKey;
  /** next-intl の translation key */
  labelKey: MessageKey;
  icon: LucideIcon;
  dangerous: boolean;
  onSelect: () => void;
}

interface TimeblockMenuItemsArgs {
  activityId?: string | null | undefined;
  onViewStats?: (() => void) | undefined;
  onCopy?: (() => void) | undefined;
  onDuplicate?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}

export function getTimeblockMenuItems({
  activityId,
  onViewStats,
  onCopy,
  onDuplicate,
  onDelete,
}: TimeblockMenuItemsArgs): TimeblockMenuItem[] {
  const items: (TimeblockMenuItem | null)[] = [
    onViewStats && activityId
      ? {
          key: 'viewStats',
          labelKey: 'calendar.filter.viewStats',
          icon: BarChart3,
          dangerous: false,
          onSelect: onViewStats,
        }
      : null,
    onCopy
      ? {
          key: 'copy',
          labelKey: 'common.actions.copy',
          icon: Copy,
          dangerous: false,
          onSelect: onCopy,
        }
      : null,
    onDuplicate
      ? {
          key: 'duplicate',
          labelKey: 'common.actions.duplicate',
          icon: CopyPlus,
          dangerous: false,
          onSelect: onDuplicate,
        }
      : null,
    onDelete
      ? {
          key: 'delete',
          labelKey: 'common.actions.delete',
          icon: Trash2,
          dangerous: true,
          onSelect: onDelete,
        }
      : null,
  ];

  return items.filter((item): item is TimeblockMenuItem => item !== null);
}
