'use client';

import { useMemo } from 'react';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ActivityIcon, useActivities, useActivitiesMap } from '@/features/activities';

import { useActivityModalNavigation } from '../../../../hooks/useActivityModalNavigation';
import { useActivityQuickCreate } from '../../hooks/useActivityQuickCreate';

import { cn } from '@dayopt/components';

interface ActivityChipRowProps {
  className?: string;
}

/**
 * モバイル専用のアクティビティチップ行。
 *
 * - タイムライン下部の固定フッターに横一列で並ぶ（カテゴリー所属・未分類が混在）
 * - タップで既定の長さのブロックを即作成し、詳細パネル（Drawer）で時刻を直す
 * - 行末に「+」ボタンを置き新規アクティビティを作成
 * - データソース: `useActivities()`（sidebar と同じ cache を参照、追加 fetch ゼロ）
 * - 並び順はサーバーの名前順に従う（`sort_order` は持たない）。PC サイドバーの
 *   `listTree` も同じ照合順序なので、client 側で並べ直すと逆にズレる
 * - アーカイブ済みは `useActivities()` の時点で除外済み
 * - 色とアイコンは所属カテゴリーから継承する。未分類は中立表示
 * - 0 件なら null を返す（行ごと非表示。初回作成は別導線）
 */
export function ActivityChipRow({ className }: ActivityChipRowProps) {
  const t = useTranslations();
  const { data: activities } = useActivities();
  const { getActivityById } = useActivitiesMap();
  const quickCreate = useActivityQuickCreate();

  const { openActivityCreateModal } = useActivityModalNavigation();

  const chips = useMemo(
    () =>
      (activities ?? []).map((activity) => {
        const display = getActivityById(activity.id);
        return {
          id: activity.id,
          name: activity.name,
          color: display?.color ?? null,
          icon: display?.icon ?? null,
        };
      }),
    [activities, getActivityById],
  );

  if (chips.length === 0) return null;

  const handleActivityTap = (activityId: string, activityName: string) => {
    quickCreate({ activityId, activityName });
  };

  return (
    <div
      className={cn(
        // 固定配置（fixed / z-index / safe-area）は呼び出し側（_shell/mobile-layout.tsx）の
        // 縦積みコンテナが担う。ここでは行としての見た目だけを持つ
        // （workspace-shell-restructure #2181 Step 3。overview.md §6-10 G）
        // 上端の区切りは呼び出し側コンテナの border-t が担うため、ここに border-b は
        // 付けない（画面最下端に不要な下線が出ていた。#2495）
        'bg-surface-container flex min-h-14 items-center gap-1 overflow-x-auto px-2 pt-1',
        // タップ領域を広く保ちつつ、横スクロール時のバウンスを抑える + スクロールバー非表示
        'scrollbar-hide overscroll-x-contain',
        className,
      )}
      // ボタンが並ぶ行なので list ではなく group。role="list" にすると子へ
      // role="listitem" が要り、interactive な button に非 interactive な role を
      // 付ける矛盾が生じる（listitem を付けるとボタンとして読まれなくなる）
      role="group"
      aria-label={t('calendar.filter.quickCreate')}
    >
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => handleActivityTap(chip.id, chip.name)}
          className="hover:bg-state-hover flex h-12 min-w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-2 transition-colors duration-150"
        >
          <ActivityIcon
            icon={chip.icon}
            color={chip.color}
            size="md"
            neutral={chip.color === null}
          />
          <span className="text-muted-foreground max-w-16 truncate text-xs">{chip.name}</span>
        </button>
      ))}

      <button
        type="button"
        aria-label={t('calendar.filter.createActivity')}
        onClick={() => openActivityCreateModal()}
        className="hover:bg-state-hover text-muted-foreground flex h-12 min-w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-2 transition-colors duration-150"
      >
        <Plus className="size-5" />
        <span className="max-w-16 truncate text-xs">{t('common.actions.add')}</span>
      </button>
    </div>
  );
}
