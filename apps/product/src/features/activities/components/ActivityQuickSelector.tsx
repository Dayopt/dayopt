'use client';

/**
 * ActivityQuickSelector
 *
 * アクティビティ選択用フローティングパネル。旧 `features/tags/components/TagQuickSelector.tsx`
 * の移植版（#2162。tags feature 自体は #2176 以降段階的に撤去済み）。単一選択 + 新規作成（グローバル ActivityCreateModal 経由）。
 * モバイル: Vaul Drawer（スワイプで閉じる）、PC: アンカー横フローティング。
 *
 * 一覧はカテゴリーでグルーピングして表示する。色・アイコンはカテゴリーだけが持ち、
 * 所属アクティビティはこれを継承する。未分類のアクティビティは継承する色が無いため
 * アイコンを出さずテキストのみで表示する（サイドバーの ActivityRow と同じ扱い、
 * 2026-08-18 User 指示）。
 *
 * 「+」押下時は自身を一旦閉じてからグローバル ActivityCreateModal を開く（vaul nested
 * Drawer 問題を避けるため）。modal の onCreated callback で selection を反映する。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { formatDurationMinutes } from '@/lib/date';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useShellStore } from '@/lib/stores/useShellStore';
import {
  Button,
  cn,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  overlaySurface,
} from '@dayopt/components';
import { getCategoryColorClasses } from '../lib/category-colors';

import { useActivityTree } from '../hooks/useActivitiesQuery';
import { ActivityIcon } from './ActivityIcon';

import type { Activity, ActivityTree } from '../types';

/**
 * サンプルアクティビティの i18n キー（`calendar.activitySelector.sampleActivities` 配下）。
 *
 * 移植元が読んでいた `calendar.tagSelector.*` は旧ピッカーの撤去と同時に削除済み（#2162）。
 */
type SampleActivityNameKey = 'work' | 'study' | 'exercise' | 'break' | 'meal';

/** アクティビティが0件のときにユーザーへ表示するサンプル候補一覧 */
const SAMPLE_ACTIVITY_CHIPS: Array<{
  nameKey: SampleActivityNameKey;
  color: string;
  icon: string;
}> = [
  { nameKey: 'work', color: 'blue', icon: 'briefcase' },
  { nameKey: 'study', color: 'indigo', icon: 'book-open' },
  { nameKey: 'exercise', color: 'green', icon: 'dumbbell' },
  { nameKey: 'break', color: 'amber', icon: 'coffee' },
  { nameKey: 'meal', color: 'orange', icon: 'utensils' },
];

/** 「未分類」チップを表す擬似カテゴリー ID（実カテゴリーの UUID とは衝突しない） */
const UNCATEGORIZED_FILTER_ID = '__uncategorized__';

const EMPTY_CATEGORIES: ActivityTree['categories'] = [];
const EMPTY_ACTIVITIES: ActivityTree['uncategorized'] = [];

/** ホバー中のアクティビティ情報（色・アイコンは所属カテゴリーからの継承値） */
export interface HoveredActivityInfo {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

interface ActivityQuickSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (activityId: string, activityName: string) => void;
  onCreateAndSelect: (
    name: string,
    color?: string | null,
    icon?: string | null,
    categoryId?: string | null,
  ) => void;
  /** アクティビティホバー時のコールバック（プレビュー用） */
  onActivityHover?: ((activity: HoveredActivityInfo | null) => void) | undefined;
  /** PC: アンカー要素の横にパネルを配置する */
  anchorRef?: React.RefObject<HTMLDivElement | HTMLButtonElement | null>;
  /** ヘッダーに表示する日付・時間帯ラベル（例: "3/30 (日) 14:00 – 15:30"） */
  timeLabel?: string | undefined;
  /**
   * activityId → 普段の長さ（分）。渡された行にだけ名前の後ろへ目安を添える。
   * 中央値の集計は timeblock feature が持つが、activities は Layer 0 なので
   * component ではなく素のデータで受け取り、依存方向を保つ（`hint` と同じ作法）。
   */
  durationByActivityId?: ReadonlyMap<string, number> | undefined;
  /**
   * timeLabel の下に出す補助表示。呼び出し側が組み立てた ReactNode をそのまま描画する。
   * activities feature は Layer 0 なので上位 feature の component を import できない。
   * ノードで受け取ることで依存方向を保ったまま合成できる（例: 作成時フィードフォワード）。
   */
  hint?: React.ReactNode | undefined;
}

interface ActivityBadgeCellProps {
  activity: Activity;
  /** 継承する表示色。未分類なら null */
  color: string | null;
  /** 継承する表示アイコン。未分類なら null */
  icon: string | null;
  isSelected: boolean;
  onSelect: () => void;
  onHover?: ((info: HoveredActivityInfo) => void) | undefined;
  onHoverEnd?: (() => void) | undefined;
  /** 未分類（カテゴリー未所属）なら true。アイコンを出さずテキストのみにする */
  uncategorized?: boolean;
  /** 名前の後ろに添える普段の長さ（分）。無い（サンプル不足）なら省略して沈黙する */
  durationMinutes?: number | undefined;
}

/** 選択用の pill badge。未分類は継承する色が無いのでアイコンを出さない */
function ActivityBadgeCell({
  activity,
  color,
  icon,
  isSelected,
  onSelect,
  onHover,
  onHoverEnd,
  uncategorized = false,
  durationMinutes,
}: ActivityBadgeCellProps) {
  // 選択中の見た目はカテゴリー色の Tailwind クラスで出す。移植元は style 属性で
  // CSS 変数を直接当てていたが、`design-system.md` が style 属性を禁じており、
  // クラス名は category-colors.ts の safelist が生成を保証している
  const colorClasses = getCategoryColorClasses(color);

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={
        onHover ? () => onHover({ id: activity.id, name: activity.name, color, icon }) : undefined
      }
      onMouseLeave={onHoverEnd}
      className={cn(
        // 上下は左右より広く取る。角丸が左右の端を削るぶん、同じ数値だと上下だけ
        // 詰まって見え、名前が窮屈になる（2026-09-07 User 指摘）
        'flex min-h-12 items-center gap-1 rounded-full border px-3 py-3 text-sm transition-colors',
        'active:scale-95 active:transition-transform',
        isSelected
          ? uncategorized
            ? // 未分類は継承する色が無いので、色ではなく選択状態のトークンで示す
              'border-border bg-state-selected text-foreground'
            : cn('text-foreground', colorClasses.border, colorClasses.tint)
          : 'border-border text-foreground hover:bg-state-hover',
      )}
    >
      {/* アクティビティ自体にはアイコンを出さない。カテゴリー見出しが既に同じ
          アイコンを出しており、pill 側で繰り返しても情報が増えない（サイドバーの
          ActivityRow と同じ規律、2026-08-18 User 指示） */}
      <span className="truncate">{activity.name}</span>
      {/* 普段の長さの目安。断定せず、選択の邪魔もしないよう地の文より小さく薄く出す
          （警告色・アイコン・感嘆符は使わない、ADR-026 のトーン）。サンプルが
          足りないアクティビティでは何も出さない */}
      {durationMinutes != null && (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatDurationMinutes(durationMinutes)}
        </span>
      )}
    </button>
  );
}

/**
 * カテゴリー絞り込みチップ。
 *
 * 選択中のチップを再タップすると解除して全件へ戻る。カテゴリー数が 1 つ以下なら
 * 呼び出し側が行ごと出さない（絞り込む意味が無いため）。
 */
function CategoryFilterChip({
  label,
  icon,
  color,
  isActive,
  onClick,
}: {
  label: string;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={cn(
        'flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-sm transition-colors',
        'active:scale-95 active:transition-transform',
        isActive
          ? 'border-border bg-state-selected text-foreground'
          : 'border-border text-muted-foreground hover:bg-state-hover hover:text-foreground',
      )}
    >
      {icon ? <ActivityIcon icon={icon} color={color ?? null} size="sm" /> : null}
      <span className="truncate">{label}</span>
    </button>
  );
}

function CreateBadge({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // 同じ一覧に並ぶので、アクティビティの pill と同じ高さ・余白にする
        'border-border hover:bg-state-hover text-muted-foreground flex min-h-12 items-center gap-1 rounded-full border border-dashed px-3 py-3 text-sm transition-colors',
        'active:scale-95 active:transition-transform',
      )}
    >
      <Plus className="size-4" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

interface ActivityPickerListProps {
  onSelect: (activityId: string, activityName: string) => void;
  onCreateAndSelect: (
    name: string,
    color?: string | null,
    icon?: string | null,
    categoryId?: string | null,
  ) => void;
  onActivityHover?: ((activity: HoveredActivityInfo | null) => void) | undefined;
  /**
   * 自身を包む overlay を閉じる関数。ActivityCreateModal を開く前に呼んで
   * vaul の nested Drawer を避ける。overlay に載っていない埋め込み用途では省略する。
   */
  closeSelf?: (() => void) | undefined;
  /**
   * `overlay`: 自前で縦スクロールし、左右に overlay 用の余白と区切り線を持つ（既定）。
   * `embedded`: スクロールも余白も持たない。高さと余白は埋め込み先のパネルが与える。
   */
  variant?: 'overlay' | 'embedded' | undefined;
  /** activityId → 普段の長さ（分）。渡された行にだけ名前の後ろへ目安を添える */
  durationByActivityId?: ReadonlyMap<string, number> | undefined;
}

/**
 * アクティビティ選択リスト（カテゴリー絞り込みチップ + 見出しごとの pill）。
 *
 * カテゴリーごとの見出し + 所属アクティビティ、末尾に「未分類」、さらに末尾の「+」で
 * グローバル ActivityCreateModal を `openActivityCreateModal({ onCreated })` で開く。
 * 所属アクティビティが 0 件のカテゴリーは見出しごと出さない（選べるものが無い
 * 見出しはノイズになるため）。
 *
 * 縦スクロールは持たない。高さの制約は呼び出し側（overlay / パネル）が与える。
 */
export function ActivityPickerList({
  onSelect,
  onCreateAndSelect,
  onActivityHover,
  closeSelf,
  variant = 'overlay',
  durationByActivityId,
}: ActivityPickerListProps) {
  const isEmbedded = variant === 'embedded';
  const t = useTranslations('calendar');
  const { data: tree } = useActivityTree();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 絞り込み中のカテゴリー。null は全件表示、UNCATEGORIZED_FILTER_ID は未分類だけ
  const [filterId, setFilterId] = useState<string | null>(null);
  const openActivityCreateModal = useShellStore.use.openActivityCreateModal();

  const categories = tree?.categories ?? EMPTY_CATEGORIES;
  const uncategorized = tree?.uncategorized ?? EMPTY_ACTIVITIES;
  const isActivityZero =
    uncategorized.length === 0 && categories.every((node) => node.activities.length === 0);

  // 選べるものが無いカテゴリーはチップにも出さない（見出しの規律と同じ）
  const chipCategories = categories.filter((node) => node.activities.length > 0);
  const showUncategorizedChip = uncategorized.length > 0;
  // チップが 1 つしか無いなら絞り込む意味が無いので行ごと出さない
  const showChipRow = chipCategories.length + (showUncategorizedChip ? 1 : 0) > 1;

  const visibleCategories =
    filterId === null ? chipCategories : chipCategories.filter((n) => n.category.id === filterId);
  const visibleUncategorized =
    filterId === null || filterId === UNCATEGORIZED_FILTER_ID ? uncategorized : EMPTY_ACTIVITIES;

  const toggleFilter = (id: string) => setFilterId((current) => (current === id ? null : id));

  const handleSelect = useCallback(
    (activityId: string, activityName: string) => {
      setSelectedId(activityId);
      onSelect(activityId, activityName);
    },
    [onSelect],
  );

  const handleOpenCreate = useCallback(() => {
    closeSelf?.();
    openActivityCreateModal({
      onCreated: (activity) => {
        // 作成は modal 側で済んでいる。caller の onCreateAndSelect は再度 mutation
        // を呼んで duplicate-name で fail するので、id を直接 onSelect に渡す。
        onSelect(activity.id, activity.name);
      },
    });
  }, [closeSelf, openActivityCreateModal, onSelect]);

  const handleHover = onActivityHover
    ? (info: HoveredActivityInfo) => onActivityHover(info)
    : undefined;
  const handleHoverEnd = onActivityHover ? () => onActivityHover(null) : undefined;

  return (
    <>
      {showChipRow ? (
        <div
          className={cn('shrink-0 pb-2', isEmbedded ? '' : 'border-border-subtle border-b px-4')}
        >
          <div
            role="group"
            aria-label={t('activitySelector.categoryFilterLabel')}
            className="scrollbar-hide flex items-center gap-2 overflow-x-auto overscroll-x-contain"
          >
            <CategoryFilterChip
              label={t('activitySelector.allCategories')}
              isActive={filterId === null}
              onClick={() => setFilterId(null)}
            />
            {chipCategories.map(({ category }) => (
              <CategoryFilterChip
                key={category.id}
                label={category.name}
                icon={category.icon}
                color={category.color}
                isActive={filterId === category.id}
                onClick={() => toggleFilter(category.id)}
              />
            ))}
            {showUncategorizedChip ? (
              <CategoryFilterChip
                label={t('filter.uncategorized')}
                isActive={filterId === UNCATEGORIZED_FILTER_ID}
                onClick={() => toggleFilter(UNCATEGORIZED_FILTER_ID)}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={cn(isEmbedded ? '' : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto')}>
        {isActivityZero ? (
          <div className={cn('space-y-2 py-4', isEmbedded ? '' : 'px-4')}>
            <div className="text-center">
              <p className="text-foreground text-sm">{t('activitySelector.emptyTitle')}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t('activitySelector.emptyDescription')}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_ACTIVITY_CHIPS.map(({ nameKey, color, icon }) => {
                const name = t(`activitySelector.sampleActivities.${nameKey}`);
                return (
                  <button
                    key={nameKey}
                    type="button"
                    onClick={() => onCreateAndSelect(name, color, icon)}
                    className="border-border hover:bg-state-hover flex items-center gap-1 rounded-full border px-2 py-1 text-sm transition-colors"
                  >
                    <ActivityIcon icon={icon} color={color} size="sm" />
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className={cn('flex flex-col gap-2 py-2', isEmbedded ? '' : 'px-4')}>
          {visibleCategories.map(({ category, activities }) =>
            activities.length > 0 ? (
              <div key={category.id} className="flex flex-col gap-2">
                <div className="text-foreground flex items-center gap-1 px-1 text-sm font-medium">
                  <ActivityIcon icon={category.icon} color={category.color} size="sm" />
                  <span className="truncate">{category.name}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activities.map((activity) => (
                    <ActivityBadgeCell
                      key={activity.id}
                      activity={activity}
                      color={category.color}
                      icon={category.icon}
                      isSelected={selectedId === activity.id}
                      onSelect={() => handleSelect(activity.id, activity.name)}
                      onHover={handleHover}
                      onHoverEnd={handleHoverEnd}
                      durationMinutes={durationByActivityId?.get(activity.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null,
          )}

          {visibleUncategorized.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="text-foreground px-1 text-sm font-medium">
                {t('filter.uncategorized')}
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleUncategorized.map((activity) => (
                  <ActivityBadgeCell
                    key={activity.id}
                    activity={activity}
                    color={null}
                    icon={null}
                    uncategorized
                    isSelected={selectedId === activity.id}
                    onSelect={() => handleSelect(activity.id, activity.name)}
                    onHover={handleHover}
                    onHoverEnd={handleHoverEnd}
                    durationMinutes={durationByActivityId?.get(activity.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <CreateBadge label={t('activitySelector.new')} onClick={handleOpenCreate} />
          </div>
        </div>
      </div>
    </>
  );
}

/** アンカー要素の横にパネルを配置する位置を計算 */
function calcAnchoredPosition(anchorRect: DOMRect, panelWidth: number, panelHeight: number) {
  const GAP = 8;
  const MARGIN = 16;
  const spaceRight = window.innerWidth - anchorRect.right - GAP - MARGIN;
  const spaceLeft = anchorRect.left - GAP - MARGIN;

  // 右に十分なスペースがあれば右、なければ左
  const left =
    spaceRight >= panelWidth
      ? anchorRect.right + GAP
      : spaceLeft >= panelWidth
        ? anchorRect.left - GAP - panelWidth
        : // どちらも足りなければ右寄せ（画面端からマージン）
          Math.max(MARGIN, window.innerWidth - panelWidth - MARGIN);

  // 縦位置: アンカーの上端に揃えつつ、画面内に収まるようクランプ
  const maxTop = window.innerHeight - MARGIN;
  const top = Math.max(MARGIN, Math.min(anchorRect.top, maxTop - panelHeight));

  return { top, left };
}

/** アクティビティ選択フローティングパネル。モバイルはDrawer、PCはアンカー横フローティング */
export function ActivityQuickSelector({
  open,
  onOpenChange,
  onSelect,
  onCreateAndSelect,
  onActivityHover,
  anchorRef,
  timeLabel,
  hint,
  durationByActivityId,
}: ActivityQuickSelectorProps) {
  const t = useTranslations('calendar');
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const mounted = useHasMounted();
  const panelRef = useRef<HTMLDivElement>(null);

  // PC: アンカー横に配置する位置を計算
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open || isMobile) return;

    const anchor = anchorRef?.current;
    if (!anchor) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const panelWidth = 320; // w-80 = 20rem = 320px
      setPosition(calcAnchoredPosition(rect, panelWidth, panelRef.current?.offsetHeight ?? 0));
    };

    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);

    // スクロール・リサイズで再計算
    window.addEventListener('resize', update);
    // カレンダーのスクロールコンテナにも対応
    const scrollParent = anchor.closest('[data-scroll-container]') ?? window;
    scrollParent.addEventListener('scroll', update, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      scrollParent.removeEventListener('scroll', update);
    };
  }, [open, isMobile, anchorRef]);

  // Escape キーで閉じる（PC のみ — Drawer は自前で処理）
  useEffect(() => {
    if (!open || isMobile) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, isMobile, onOpenChange]);

  // PC: カレンダーを操作可能なまま、パネルとアンカー外の pointer down だけで閉じる。
  useEffect(() => {
    if (!open || isMobile) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onOpenChange(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open, isMobile, anchorRef, onOpenChange]);

  const closeSelf = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!mounted) return null;

  // モバイル: Vaul Drawer（スワイプで閉じる）
  // 背後の calendar grid は操作させず、sheet 内の選択に集中させる。
  // handleOnly でアクティビティリスト内のスクロール・タップが drawer dismiss を誘発しない。
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} handleOnly>
        {/* eslint-disable-next-line tailwindcss/no-arbitrary-value -- viewport unit */}
        <DrawerContent className="flex max-h-[80vh] flex-col">
          <DrawerHeader className="shrink-0">
            <DrawerTitle>{t('activitySelector.title')}</DrawerTitle>
            {timeLabel && <p className="text-muted-foreground text-sm">{timeLabel}</p>}
            {hint}
          </DrawerHeader>
          <ActivityPickerList
            onSelect={onSelect}
            onCreateAndSelect={onCreateAndSelect}
            onActivityHover={onActivityHover}
            closeSelf={closeSelf}
            durationByActivityId={durationByActivityId}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  // PC: フローティングパネル
  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('activitySelector.title')}
      className={cn(
        overlaySurface(),
        // eslint-disable-next-line tailwindcss/no-arbitrary-value -- セレクタ高は viewport 単位 70vh が必要でトークン化不可
        'z-overlay-popover fixed flex max-h-[70vh] w-80 flex-col',
        'animate-in fade-in duration-150',
      )}
      style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-4 pb-2">
        <div className="min-w-0">
          <h2 className="font-medium">{t('activitySelector.title')}</h2>
          {timeLabel && <p className="text-muted-foreground truncate text-sm">{timeLabel}</p>}
          {hint}
        </div>
        <Button
          type="button"
          variant="ghost"
          icon
          size="lg"
          onClick={() => onOpenChange(false)}
          aria-label={t('actions.close')}
          className="shrink-0"
        >
          <X className="size-4" />
        </Button>
      </div>

      <ActivityPickerList
        onSelect={onSelect}
        onCreateAndSelect={onCreateAndSelect}
        onActivityHover={onActivityHover}
        closeSelf={closeSelf}
        durationByActivityId={durationByActivityId}
      />
    </div>
  );

  return createPortal(panel, document.body);
}
