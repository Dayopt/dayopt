'use client';

import { useCallback, useMemo } from 'react';

import { resolveNextPeriodStartDayKey, type ReportGranularity } from '@/features/review';
import { serializeTimeblockParam, TIMEBLOCK_PARAM } from '@/features/timeblock';
import { useRouter } from '@dayopt/i18n/navigation';

interface UseReportJumpOptions {
  anchorDate: string;
  granularity: ReportGranularity;
  weekStartsOn: 0 | 1 | 6;
}

interface ReportJumpHandlers {
  /** 未分類の記録の日をカレンダーで開き、その記録の編集パネルを開く。 */
  onJumpToRecord: (target: { id: string; dayKey: string }) => void;
  /** その日をカレンダー（日ビュー）で開くだけ。未変換の外部予定の確認に使う。 */
  onJumpToDay: (dayKey: string) => void;
  /** 次期間の初日をカレンダー（週ビュー）で開く。 */
  onJumpToNextPeriod: () => void;
}

/**
 * レポート 4 章からカレンダーへのジャンプ（仕様 §7）。
 *
 * `features/review` は同層の `features/calendar` を import できないため、ルーティングは
 * `ReportViewClient` と同じ Composition Bridge が持つ。review 本体は props のコールバックで
 * 受け取り、`useRouter` にも inspector store にも触れない（Storybook・単体 test で
 * context を要求しないでいられる）。
 *
 * カレンダー側の `?view=&date=` は `CalendarNavigationContext` が初期化時に読むので、
 * ここでは URL を組んで push するだけでよい（`WorkspaceTabs` の href と同じ形）。
 */
export function useReportJump({
  anchorDate,
  granularity,
  weekStartsOn,
}: UseReportJumpOptions): ReportJumpHandlers {
  const router = useRouter();

  const onJumpToRecord = useCallback(
    (target: { id: string; dayKey: string }) => {
      // 記録は URL の `?timeblock=record:<id>` で開く（検索結果と同じ経路。
      // `useInspectorURLSync` が client navigation 後に読んで Inspector を開く）。
      // 以前は router.push の直後に store の openInspector を呼んでいたが、
      // その pushState が App Router の遷移中に割り込み、/calendar への遷移自体が
      // 起きなかった（2026-09-14 実測。レポートに Inspector が一瞬開いて閉じるだけ）
      const params = new URLSearchParams({ view: 'day', date: target.dayKey });
      params.set(TIMEBLOCK_PARAM, serializeTimeblockParam(target.id, 'record'));
      router.push(`/calendar?${params.toString()}`);
    },
    [router],
  );

  const onJumpToDay = useCallback(
    (dayKey: string) => {
      router.push(`/calendar?view=day&date=${dayKey}`);
    },
    [router],
  );

  const onJumpToNextPeriod = useCallback(() => {
    const dayKey = resolveNextPeriodStartDayKey(anchorDate, granularity, weekStartsOn);
    router.push(`/calendar?view=week&date=${dayKey}`);
  }, [anchorDate, granularity, router, weekStartsOn]);

  return useMemo(
    () => ({ onJumpToDay, onJumpToNextPeriod, onJumpToRecord }),
    [onJumpToDay, onJumpToNextPeriod, onJumpToRecord],
  );
}
