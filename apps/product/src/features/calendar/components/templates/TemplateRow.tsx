'use client';

import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { cn, Popover, PopoverContent, PopoverTrigger } from '@dayopt/components';

import { MiniDayPreview } from './MiniDayPreview';
import { TemplateContextMenu } from './TemplateContextMenu';
import type { TemplateView } from './types';

type TemplateRowVisualState = 'idle' | 'applying' | 'dragging';

interface TemplateRowProps {
  template: TemplateView;
  /** クリック適用・ドラッグ中などの静的な視覚状態（Storybook 確認用） */
  visualState?: TemplateRowVisualState | undefined;
  onApply?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onRename?: ((name: string) => void) | undefined;
  onDelete?: (() => void) | undefined;
}

/**
 * サイドバーのテンプレート行（v1.0 §5.4）。
 *
 * 見る＝ホバーでミニチュア日ビューのプレビュー（PC のみの挙動）。使う＝
 * クリックで適用、ドラッグで任意の日へ。統治（改名・削除）＋型を一日として
 * 開く「編集」は右クリックに畳む。
 *
 * サイドバー内での並び替え DnD は持たない（`design-system.md` §ドラッグ操作
 * の既存方針どおり、リスト並び替えの DnD は廃止済み。ドラッグは「任意の日へ
 * 適用する」ための操作であり、行の順序を変える操作ではない）。
 *
 * この component は Storybook-only の視覚確認用で、実際のドラッグ挙動・
 * 適用 mutation・改名 mutation・編集ビューへの遷移は本 issue の非 scope
 * （後続の実装 issue）。`visualState` は「クリック適用中」「ドラッグ中」の
 * 見た目を Story で静的に確認するためのフラグで、実インタラクションの
 * state machine ではない。
 */
export function TemplateRow({
  template,
  visualState = 'idle',
  onApply,
  onEdit,
  onRename,
  onDelete,
}: TemplateRowProps) {
  const t = useTranslations();
  const [isHovered, setIsHovered] = useState(false);
  // ミニプレビューはホバーだけでなくフォーカスでも出す。キーボードだけで
  // 操作する人には、ホバー限定だとプレビューへ到達する手段が無くなる
  // （WCAG 1.4.13 Content on Hover or Focus）
  const [isFocused, setIsFocused] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(template.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
  };

  const handleStartRename = () => {
    setRenameValue(template.name);
    setIsRenaming(true);
    // フォーカスは input mount 後の次 tick で当てる
    requestAnimationFrame(() => renameInputRef.current?.select());
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== template.name) {
      onRename?.(trimmed);
    }
    setIsRenaming(false);
  };

  return (
    <div
      data-template-row
      data-visual-state={visualState}
      className={cn(
        'group/template-row relative flex min-w-0 items-center gap-2 rounded-lg px-2 py-1',
        visualState === 'dragging' ? 'opacity-30' : 'hover:bg-state-hover',
        visualState === 'applying' && 'bg-state-hover',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={handleContextMenu}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          aria-label={t('calendar.templates.renameLabel')}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setIsRenaming(false);
            }
          }}
          className="border-border bg-background text-foreground w-full min-w-0 rounded-lg border px-2 py-1 text-sm outline-none"
        />
      ) : (
        <Popover open={(isHovered || isFocused) && !contextMenuPosition}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-foreground focus-visible:ring-ring min-w-0 flex-1 truncate rounded-lg text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => onApply?.()}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
            >
              {template.name}
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="h-96 w-64 p-3">
            <MiniDayPreview blocks={template.blocks} />
          </PopoverContent>
        </Popover>
      )}

      {contextMenuPosition && (
        <TemplateContextMenu
          position={contextMenuPosition}
          onClose={() => setContextMenuPosition(null)}
          onEdit={onEdit}
          onRename={handleStartRename}
          onDelete={() => onDelete?.()}
        />
      )}

      <span className="sr-only">
        {t('calendar.templates.rowAriaHint', { name: template.name })}
      </span>
    </div>
  );
}
