'use client';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { trpc } from '@/lib/trpc/client';

import type { ReportGranularity } from '../lib/report-period';

/**
 * レポートの期間集計を取得する。
 *
 * timezone と週の開始曜日はユーザー設定から取り、URL には載せない（共有リンクの相手は
 * 自分の設定で読む）。期間の正本は URL の `date` / `range` で、その 2 つを引数で受ける。
 *
 * **`/report` の各タブはこの 1 本だけを読む。** フィルタやタブの切替で再取得しない
 * （派生は `domain/report/` の純粋関数が client で行う）。詳細パネルだけが別の
 * procedure を持つので、将来「深掘りは Pro」にするならそちら側で分岐する。
 */
export function useReportPeriod(anchorDate: string, granularity: ReportGranularity) {
  const timezone = useUserPreferences((s) => s.timezone);
  const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);

  return trpc.review.getReportPeriod.useQuery(
    { anchorDate, granularity, timezone, weekStartsOn },
    {
      // 期間を往復しても即座に前の数字が出る。集計は分単位で動かないので長めに持つ。
      staleTime: 60_000,
    },
  );
}
