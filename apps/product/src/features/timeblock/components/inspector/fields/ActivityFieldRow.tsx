'use client';

/**
 * アクティビティ選択トリガー（Pure props）
 *
 * アイコン + アクティビティ名を表示し、クリックで ActivityQuickSelector を開く。
 * `variant` で表示密度を切り替える:
 * - `heading`（既定）: 見出し相当の重さ。
 * - `compact`: 軽量なタップ要素。
 * - `card`: Inspector のカード全面を選択トリガーにし、カテゴリーも表示する。
 *
 * 「…」メニュー・閉じるボタンはこのコンポーネントの責務ではない。同じヘッダー行に並ぶ
 * InspectorHeaderActions が担う（アクティビティ表示を移動・縮小しても、それらの導線は動かない）。
 *
 * アクティビティデータの解決と作成は上位が担当。
 *
 * 色・アイコンを持つのはカテゴリーだけで、アクティビティはこれを継承する（#2162 §4-6）。
 * 未分類（継承元カテゴリーが無い）と「アクティビティなし」はどちらも中立表示になるが
 * 別概念なので、`activityId === null` を「アクティビティなし」の判定に使う。
 */

import { useCallback, useRef, useState } from 'react';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  ActivityIcon,
  ActivityQuickSelector,
  getCategoryColorClasses,
} from '@/features/activities';

import { Button, cn } from '@dayopt/components';
import { useTimeblockInspectorStore } from '../../../stores/useTimeblockInspectorStore';

interface ActivityFieldRowProps {
  activityId: string | null;
  /** 解決済みのアクティビティ名 */
  activityName: string;
  /** 解決済みの所属カテゴリー名。card で補足表示する。 */
  categoryName?: string | null | undefined;
  /** 解決済みの継承アイコン名（未分類・未設定なら null） */
  activityIcon?: string | null | undefined;
  /** 解決済みの継承色名（未分類・未設定なら null） */
  activityColor?: string | null | undefined;
  /**
   * アクティビティがカテゴリーに所属していない（= 継承する色が無い）。
   *
   * color の null 判定では「カテゴリーはあるが color 未設定」と区別できないため、
   * 呼び出し元が categoryId の実在から明示的に渡す（ActivityIcon の neutral 契約）。
   */
  uncategorized?: boolean | undefined;
  onActivityChange: (activityId: string | null) => void;
  /** アクティビティ作成コールバック（上位で useCreateActivity を呼ぶ） */
  onCreateAndSelect: (
    name: string,
    color?: string | null,
    icon?: string | null,
    categoryId?: string | null,
  ) => void;
  disabled?: boolean | undefined;
  /** 見た目の重さ。既定は `heading`（見出し相当）。 */
  variant?: 'heading' | 'compact' | 'card' | undefined;
  /**
   * activityId → 普段の長さ（分）。選択一覧の各行へ目安として添える。
   * 集計を引くのは呼び出し側（この component は pure props を保つ）。
   */
  durationByActivityId?: ReadonlyMap<string, number> | undefined;
}

/** アクティビティ選択トリガー（アイコン + 名前、タップで QuickSelector 表示） */
export function ActivityFieldRow({
  activityId,
  activityName,
  categoryName,
  activityIcon,
  activityColor,
  uncategorized = false,
  onActivityChange,
  onCreateAndSelect,
  disabled = false,
  variant = 'heading',
  durationByActivityId,
}: ActivityFieldRowProps) {
  const t = useTranslations();
  const [selectorOpen, setSelectorOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 開いているブロックのカードへ、選ぶ前の色・アイコン・名前を先出しする
  const setHoveredActivity = useTimeblockInspectorStore((state) => state.setHoveredActivity);
  const isCompact = variant === 'compact';
  const isCard = variant === 'card';
  const iconColorClasses =
    activityId !== null && !uncategorized ? getCategoryColorClasses(activityColor) : null;

  const handleSelect = useCallback(
    (selectedActivityId: string) => {
      onActivityChange(selectedActivityId);
      setHoveredActivity(null);
      setSelectorOpen(false);
    },
    [onActivityChange, setHoveredActivity],
  );

  const handleCreateAndSelect = useCallback(
    async (
      name: string,
      color?: string | null,
      icon?: string | null,
      categoryId?: string | null,
    ) => {
      await onCreateAndSelect(name, color, icon, categoryId);
      setSelectorOpen(false);
    },
    [onCreateAndSelect],
  );

  const trigger = isCard ? (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      onClick={() => setSelectorOpen(true)}
      disabled={disabled}
      className={cn(
        'border-border-subtle bg-card hover:bg-state-hover group ease-standard h-auto w-full cursor-pointer justify-start gap-3 rounded-2xl p-4 text-left shadow-sm duration-150',
        selectorOpen && 'bg-state-selected ring-border ring-1',
      )}
      aria-label={`${t('calendar.filter.changeActivity')}: ${activityName}`}
      aria-haspopup="dialog"
      aria-expanded={selectorOpen}
    >
      <span
        className={cn(
          'flex size-14 shrink-0 items-center justify-center rounded-lg',
          iconColorClasses?.tint,
        )}
      >
        <ActivityIcon
          icon={activityIcon ?? null}
          color={activityColor ?? null}
          size="lg"
          neutral={activityId === null || uncategorized}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground truncate text-lg font-medium" title={activityName}>
          {activityName}
        </span>
        <span
          className="text-muted-foreground truncate text-sm font-normal"
          title={categoryName ?? undefined}
        >
          {categoryName ??
            t(
              activityId !== null && uncategorized
                ? 'calendar.filter.uncategorized'
                : 'calendar.filter.noCategory',
            )}
        </span>
      </span>
      <ChevronDown
        className="text-muted-foreground group-hover:text-foreground size-4 shrink-0"
        aria-hidden
      />
    </Button>
  ) : (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setSelectorOpen(true)}
      disabled={disabled}
      className={cn(
        'hover:bg-state-hover -ml-2 flex min-w-0 items-center gap-2 rounded-lg transition-colors',
        isCompact ? 'px-2 py-1 text-sm' : '-mt-1 py-1 pr-2 pl-2 text-lg font-medium',
      )}
      aria-label={`${t('calendar.filter.changeActivity')}: ${activityName}`}
    >
      <ActivityIcon
        icon={activityIcon ?? null}
        color={activityColor ?? null}
        size={isCompact ? 'sm' : 'md'}
        className="flex-shrink-0"
        neutral={activityId === null || uncategorized}
      />
      <span className="text-foreground truncate">{activityName}</span>
      <ChevronDown
        className={cn('text-muted-foreground flex-shrink-0', isCompact ? 'size-3.5' : 'size-4')}
        aria-hidden
      />
    </button>
  );

  return (
    <>
      {isCompact ? <div className="flex min-h-11 items-center">{trigger}</div> : trigger}

      <ActivityQuickSelector
        open={selectorOpen}
        onOpenChange={(open) => {
          if (!open) setHoveredActivity(null);
          setSelectorOpen(open);
        }}
        onSelect={handleSelect}
        onCreateAndSelect={handleCreateAndSelect}
        onActivityHover={setHoveredActivity}
        anchorRef={buttonRef}
        durationByActivityId={durationByActivityId}
      />
    </>
  );
}
