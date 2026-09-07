'use client';

import { Fragment, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { getTimeblockMenuItems } from '@/features/timeblock';
import { cn, overlaySurface } from '@dayopt/components';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

interface TimeblockContextMenuProps {
  entry: CalendarDisplayEvent;
  position: { x: number; y: number };
  onClose: () => void;
  onDelete?: ((entry: CalendarDisplayEvent) => void) | undefined;
  onViewStats?: ((entry: CalendarDisplayEvent) => void) | undefined;
  onCopy?: ((entry: CalendarDisplayEvent) => void) | undefined;
  onDuplicate?: ((entry: CalendarDisplayEvent) => void) | undefined;
}

/** エントリの右クリックコンテキストメニューコンポーネント */
export const EventContextMenu = ({
  entry,
  position,
  onClose,
  onDelete,
  onViewStats,
  onCopy,
  onDuplicate,
}: TimeblockContextMenuProps) => {
  const t = useTranslations();
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // 画面外に出ないよう位置調整
  useEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      const rect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let { x } = position;
      let { y } = position;

      // 右端を超える場合は左に表示
      if (x + rect.width > viewportWidth - 10) {
        x = Math.max(10, viewportWidth - rect.width - 10);
      }

      // 下端を超える場合は上に表示
      if (y + rect.height > viewportHeight - 10) {
        y = Math.max(10, viewportHeight - rect.height - 10);
      }

      setAdjustedPosition({ x, y });
    }
  }, [position]);

  // メニューが開いたら最初の項目にフォーカス
  useEffect(() => {
    const timer = setTimeout(() => {
      const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      firstItem?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // 外部クリック・Escape・Arrow keyナビゲーション
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
        if (!items?.length) return;
        const currentIndex = Array.from(items).findIndex((el) => el === document.activeElement);
        const nextIndex =
          e.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  // 共通の menu items 定義から取得（Inspector の TagRow と同じ source）
  const menuItems = getTimeblockMenuItems({
    onViewStats: onViewStats ? () => onViewStats(entry) : undefined,
    onCopy: onCopy ? () => onCopy(entry) : undefined,
    onDuplicate: onDuplicate ? () => onDuplicate(entry) : undefined,
    onDelete:
      onDelete && entry.recordSource !== 'auto_migrated' ? () => onDelete(entry) : undefined,
  });

  if (menuItems.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('calendar.contextMenu.title')}
      className={cn(
        overlaySurface(),
        'animate-in fade-in-0 zoom-in-95 z-context-menu fixed min-w-48 p-1 motion-reduce:animate-none',
      )}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {menuItems.map((item, index) => {
        const IconComponent = item.icon;
        const showSeparator = item.dangerous && index > 0 && !menuItems[index - 1]?.dangerous;

        return (
          <Fragment key={item.key}>
            {showSeparator && <div role="separator" className="bg-border-subtle -mx-1 my-1 h-px" />}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => handleAction(item.onSelect)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm outline-hidden transition-colors select-none',
                "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                item.dangerous
                  ? 'text-destructive hover:bg-destructive-state-hover focus:bg-destructive-state-hover'
                  : "text-foreground hover:bg-state-hover focus:bg-state-hover [&_svg:not([class*='text-'])]:text-muted-foreground",
              )}
            >
              <IconComponent />
              <span>{t(item.labelKey)}</span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
};
