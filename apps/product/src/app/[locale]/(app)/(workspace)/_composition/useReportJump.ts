'use client';

import { useCallback, useMemo } from 'react';

import { serializeTimeblockParam, TIMEBLOCK_PARAM } from '@/features/timeblock';
import { useRouter } from '@dayopt/i18n/navigation';

interface ReportJumpHandlers {
  /** 記録の日をカレンダーで開き、その記録の編集パネルを開く。 */
  onJumpToRecord: (target: { id: string; dayKey: string }) => void;
}

/**
 * レポートからカレンダーへのジャンプ（仕様 §7）。詳細パネルの明細行が使う。
 *
 * `features/review` は同層の `features/calendar` を import できないため、ルーティングは
 * `ReportViewClient` と同じ Composition Bridge が持つ。review 本体は props のコールバックで
 * 受け取り、`useRouter` にも inspector store にも触れない（Storybook・単体 test で
 * context を要求しないでいられる）。
 *
 * カレンダー側の `?view=&date=` は `CalendarNavigationContext` が初期化時に読むので、
 * ここでは URL を組んで push するだけでよい（`WorkspaceTabs` の href と同じ形）。
 */
export function useReportJump(): ReportJumpHandlers {
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

  return useMemo(() => ({ onJumpToRecord }), [onJumpToRecord]);
}
