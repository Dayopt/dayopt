'use client';

/**
 * アクティビティ選択トリガー（Pure props）
 *
 * アイコン + アクティビティ名を表示し、クリックで ActivityQuickSelector を開く。
 * 2 つの呼び出し元で見た目の重さが異なるため `variant` で切り替える（#2298）:
 * - `heading`（既定）: 見出し相当の重さ。`ActivityTimeblockCreateForm`（activity-filter の
 *   ブロック作成 popover）はこのフォームの唯一の識別要素として使うため、この重さを保つ
 * - `compact`: Inspector パネルのヘッダー行に置く軽量なタップ要素。
 *   `TimeblockInspectorForm` から描画される（Plan/Record エディタ、#2430でヘッダー行へ移動）
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

import { ActivityIcon, ActivityQuickSelector } from '@/features/activities';

import { cn } from '@dayopt/components';
import { useTimeblockInspectorStore } from '../../../stores/useTimeblockInspectorStore';

interface ActivityFieldRowProps {
  activityId: string | null;
  /** 解決済みのアクティビティ名 */
  activityName: string;
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
  variant?: 'heading' | 'compact' | undefined;
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

  const trigger = (
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
