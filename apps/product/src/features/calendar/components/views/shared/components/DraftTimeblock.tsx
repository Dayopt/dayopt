'use client';

import { useCallback, useMemo, type KeyboardEvent } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { ActivityIcon, getCategoryColorClasses } from '@/features/activities';
import { buildNewTimeblockOverlapTarget } from '@/features/calendar/lib/overlap';
import { timeblockTintColor } from '@/features/timeblock';
import { formatTimeString } from '@/lib/date';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { hasTwoLayerTimeConflict } from '@/lib/time';
import { cn } from '@dayopt/components';

import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../../../../domain/precision';
import {
  useActivityDraftStore,
  type ActivityDraft,
} from '../../../../stores/useActivityDraftStore';
import { Z_INDEX } from '../constants/grid.constants';
import { ConflictOverlay } from './ConflictOverlay';

/** 矢印キー 1 回で動かす分数。Shift 併用で 60 分になる */
const RESIZE_KEY_STEP_MINUTES = 15;

/** plans.list / records.list の cached query を判定する predicate（tRPC v11 key 形式） */
function isTimeblocksListQuery(query: { queryKey: unknown }): boolean {
  const key = query.queryKey;
  return (
    Array.isArray(key) &&
    key.length >= 1 &&
    Array.isArray(key[0]) &&
    (key[0][0] === 'plans' || key[0][0] === 'records') &&
    key[0][1] === 'list'
  );
}

interface DraftTimeblockProps {
  /** この列が表示する日付（draft.date と同日のときだけ render する想定） */
  draft: ActivityDraft;
  hourHeight: number;
}

/**
 * アクティビティタップで開く draft Timeblock の Calendar 上のプレビュー。
 *
 * - InlineActivityPalette と同じ視覚（左 accent strip + 右 tinted card）
 * - 下端に drawer pill 風の resize handle。drag で end time を更新
 * - drag 中は 1 分粒度、24:00 を超えない・最小ブロック長より短くならない
 * - クリックは popover 側の interaction を阻害しないよう pointer-events: none を基本にし、
 *   resize handle のみ pointer-events: auto
 * - 同一レーンの Timeblock と時間が重なる時は赤リング（drag ghost と同じ規範）
 */
export function DraftTimeblock({ draft, hourHeight }: DraftTimeblockProps) {
  const t = useTranslations();
  const timeFormat = useUserPreferences((s) => s.timeFormat);
  const updateTimes = useActivityDraftStore((s) => s.updateTimes);
  const queryClient = useQueryClient();

  const [startH, startM] = parseHHMM(draft.startTime);
  const [endH, endM] = parseHHMM(draft.endTime);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const top = startMinutes * (hourHeight / 60);
  const height = Math.max(20, (endMinutes - startMinutes) * (hourHeight / 60));

  const accentColor = getCategoryColorClasses(draft.activity.color).cssVar;
  // TimeblockCard と同じ 18% color-mix tint を使い、確定後カードと背景色を揃える
  const tintColor = timeblockTintColor(accentColor);

  const timeLabel = `${formatTimeString(startH, startM, timeFormat)} – ${formatTimeString(endH, endM, timeFormat)}`;

  // 過去の時間帯は保存時に自動で unplanned になるため、preview もダッシュ枠の unplanned 風に切替える。
  // Date.now() を毎レンダー読むのは preview の存在中に past 境界を跨ぐ稀ケースに追随するため許容。
  // eslint-disable-next-line react-hooks/purity -- transient preview component, no observable side effect
  const nowForPastCheck = Date.now();
  const isPastEndDate = new Date(draft.date);
  isPastEndDate.setHours(endH, endM, 0, 0);
  const isPast = isPastEndDate.getTime() <= nowForPastCheck;

  // 同一レーンの Timeblock と時間が重なるか判定（drag ghost と同じく赤リングを描画する用）
  const hasConflict = useMemo(() => {
    if (endMinutes <= startMinutes) return false;
    const startDate = new Date(draft.date);
    startDate.setHours(startH, startM, 0, 0);
    const endDate = new Date(draft.date);
    endDate.setHours(endH, endM, 0, 0);

    const cachedLists = queryClient.getQueriesData<
      Array<{
        id: string;
        start_at: string;
        end_at: string;
      }>
    >({ predicate: isTimeblocksListQuery });

    const seen = new Set<string>();
    const events: Array<{
      id: string;
      plannedStart: string | null;
      plannedEnd: string | null;
      actualStart: string | null;
      actualEnd: string | null;
    }> = [];
    for (const [queryKey, data] of cachedLists) {
      if (!data) continue;
      const lane = Array.isArray(queryKey) && Array.isArray(queryKey[0]) ? queryKey[0][0] : null;
      for (const timeblock of data) {
        if (seen.has(timeblock.id)) continue;
        seen.add(timeblock.id);
        events.push({
          id: timeblock.id,
          plannedStart: lane === 'plans' ? timeblock.start_at : null,
          plannedEnd: lane === 'plans' ? timeblock.end_at : null,
          actualStart: lane === 'records' ? timeblock.start_at : null,
          actualEnd: lane === 'records' ? timeblock.end_at : null,
        });
      }
    }

    return hasTwoLayerTimeConflict(
      events,
      buildNewTimeblockOverlapTarget(startDate, endDate, nowForPastCheck),
    );
  }, [
    queryClient,
    draft.date,
    startH,
    startM,
    endH,
    endM,
    startMinutes,
    endMinutes,
    nowForPastCheck,
  ]);

  const handleResizeStart = useCallback(
    (clientY: number) => {
      const startEndMinutes = endMinutes;
      const minEndMinutes = startMinutes + MIN_TIMEBLOCK_DURATION_MINUTES;

      const handleMove = (event: PointerEvent) => {
        const deltaPx = event.clientY - clientY;
        const deltaMinutes = Math.round((deltaPx / hourHeight) * 60);
        const next = Math.max(minEndMinutes, Math.min(24 * 60, startEndMinutes + deltaMinutes));
        if (next === endMinutes) return;
        const nh = Math.floor(next / 60);
        const nm = next % 60;
        updateTimes({ endTime: `${pad(nh)}:${pad(nm)}` });
      };

      const handleUp = () => {
        document.removeEventListener('pointermove', handleMove);
        document.removeEventListener('pointerup', handleUp);
        document.removeEventListener('pointercancel', handleUp);
      };

      document.addEventListener('pointermove', handleMove);
      document.addEventListener('pointerup', handleUp);
      document.addEventListener('pointercancel', handleUp);
    },
    [endMinutes, hourHeight, startMinutes, updateTimes],
  );

  // role="slider" を名乗る以上、矢印キーで値が動かないと読み上げと実態が食い違う。
  // 上下で 15 分、Shift 併用で 1 時間、Home / End で最小 / その日の終わり。
  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const minEndMinutes = startMinutes + MIN_TIMEBLOCK_DURATION_MINUTES;
      const step = event.shiftKey ? 60 : RESIZE_KEY_STEP_MINUTES;

      let next: number | null = null;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = endMinutes + step;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = endMinutes - step;
      else if (event.key === 'Home') next = minEndMinutes;
      else if (event.key === 'End') next = 24 * 60;
      if (next === null) return;

      event.preventDefault();
      event.stopPropagation();
      const clamped = Math.max(minEndMinutes, Math.min(24 * 60, next));
      if (clamped === endMinutes) return;
      updateTimes({ endTime: `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}` });
    },
    [endMinutes, startMinutes, updateTimes],
  );

  return (
    <div
      data-activity-draft-block
      className="pointer-events-none absolute right-0 left-0"
      style={{ zIndex: Z_INDEX.POPOVER }}
    >
      <div
        className={cn(
          'animate-in fade-in-0 absolute right-0 left-0 flex motion-reduce:animate-none',
          'rounded-r-lg',
        )}
        style={{
          top,
          height,
          // past（unplanned 風）も確定後カードと同じ作り: 左アクセント + tint 塗り + 3 辺破線
          ...(isPast && !hasConflict
            ? {
                borderTop: `2px dashed ${accentColor}`,
                borderRight: `2px dashed ${accentColor}`,
                borderBottom: `2px dashed ${accentColor}`,
                borderRadius: '0 8px 8px 0',
              }
            : {}),
        }}
      >
        {hasConflict ? (
          // drag/resize/新規選択と同一の ConflictOverlay に統一。
          // ブロックは rounded-r-lg（左角四角 + 3px アクセント）なので左角を四角にして全面を覆う。
          <ConflictOverlay
            message={t('timeblock.errors.timeOverlap')}
            timeLabel={timeLabel}
            compact={height < 40}
            className="absolute inset-0 rounded-l-none"
          />
        ) : (
          <>
            {/* upcoming はアクセント無しで揃える。確定後カードと文言位置を合わせるための
                3px スペーサーのみ残す（色は本体と同じで不可視）。 */}
            <div className="shrink-0" style={{ width: '3px', backgroundColor: tintColor }} />
            {/* card 本体 — past も確定後カードと同じ tint 塗り */}
            <div
              className={cn('relative min-w-0 flex-1 overflow-hidden', 'rounded-r-lg')}
              style={{ backgroundColor: tintColor }}
            >
              {height < 40 ? (
                <div className="flex h-full items-center gap-1 px-2">
                  {draft.activity.icon && (
                    <ActivityIcon
                      icon={draft.activity.icon}
                      color={draft.activity.color}
                      size="sm"
                      className="shrink-0"
                    />
                  )}
                  <span className="text-foreground truncate text-xs font-normal">
                    {draft.activity.name}
                  </span>
                </div>
              ) : (
                <div className="flex h-full flex-col gap-1 p-2">
                  <div className="flex items-center gap-1">
                    {draft.activity.icon && (
                      <ActivityIcon
                        icon={draft.activity.icon}
                        color={draft.activity.color}
                        size="sm"
                        className="shrink-0"
                      />
                    )}
                    <span className="text-foreground min-w-0 truncate text-sm leading-tight font-normal">
                      {draft.activity.name}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs leading-tight tabular-nums">
                    {timeLabel}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
        {/* resize pill — pointer-events を有効化 */}
        <span
          aria-hidden
          className="bg-muted-foreground pointer-events-none absolute bottom-0 left-1/2 hidden h-1 w-8 -translate-x-1/2 rounded-full opacity-100"
          style={{ zIndex: 1 }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('calendar.timeblock.adjustEndTime')}
          aria-orientation="vertical"
          aria-valuenow={endMinutes - startMinutes}
          aria-valuemin={15}
          aria-valuemax={24 * 60}
          className="pointer-events-auto absolute right-0 left-0 cursor-ns-resize"
          style={{
            height: '44px',
            bottom: '-40px',
            zIndex: 2,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleResizeStart(e.clientY);
          }}
          onKeyDown={handleResizeKeyDown}
        />
      </div>
    </div>
  );
}

function parseHHMM(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
