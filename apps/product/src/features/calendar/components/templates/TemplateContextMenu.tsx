'use client';

import { Fragment, useEffect, useRef, useState } from 'react';

import { Pencil, SquarePen, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn, overlaySurface } from '@dayopt/components';

interface TemplateContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  /** 「型を一日として開く」。未配線の間は項目自体を出さない（#2567 では非 scope） */
  onEdit?: (() => void) | undefined;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * テンプレート行の「直す」（型を一日として開く）＋統治（改名・削除）を
 * 右クリックに畳んだメニュー（v1.0 §5.4）。
 *
 * `TimeblockContextMenu.tsx` の `EventContextMenu` と同じ位置追従・
 * フォーカス管理・矢印キー操作パターンを踏襲する（packages/components に
 * Radix ContextMenu primitive が無いため、既存の自前実装パターンに合わせる。
 * 2 箇所目の右クリックメニューが必要になった段階で共有 primitive への
 * 昇格を再検討する）。
 */
export function TemplateContextMenu({
  position,
  onClose,
  onEdit,
  onRename,
  onDelete,
}: TemplateContextMenuProps) {
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

      if (x + rect.width > viewportWidth - 10) {
        x = Math.max(10, viewportWidth - rect.width - 10);
      }
      if (y + rect.height > viewportHeight - 10) {
        y = Math.max(10, viewportHeight - rect.height - 10);
      }

      setAdjustedPosition({ x, y });
    }
  }, [position]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      firstItem?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

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

  const items = [
    ...(onEdit
      ? [
          {
            key: 'edit',
            labelKey: 'calendar.templates.editLabel' as const,
            icon: SquarePen,
            dangerous: false,
            onSelect: onEdit,
          },
        ]
      : []),
    {
      key: 'rename',
      labelKey: 'common.actions.rename' as const,
      icon: Pencil,
      dangerous: false,
      onSelect: onRename,
    },
    {
      key: 'delete',
      labelKey: 'common.actions.delete' as const,
      icon: Trash2,
      dangerous: true,
      onSelect: onDelete,
    },
  ];

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('calendar.templates.contextMenuTitle')}
      className={cn(
        overlaySurface(),
        'animate-in fade-in-0 zoom-in-95 z-context-menu fixed min-w-40 p-1 motion-reduce:animate-none',
      )}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {items.map((item, index) => {
        const IconComponent = item.icon;
        const showSeparator = item.dangerous && index > 0 && !items[index - 1]?.dangerous;
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
}
