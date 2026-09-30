'use client';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { trpc } from '@/lib/trpc/client';

import type { ReportGranularity } from '../lib/report-period';

/**
 * 詳細パネルの明細を取る。
 *
 * **パネルが閉じている間は取りに行かない**（`enabled`）。3タブは `getReportPeriod` の
 * 1 本だけで描けるので、開くまで箱の明細を運ばない（#2576 の設計）。
 *
 * `activityId` が `null` は「アクティビティ未設定の記録」で、開いていない状態とは区別する
 * （閉じている時はそもそも呼ばない）。
 */
export function useReportActivityDetail(options: {
  activityId: string | null;
  anchorDate: string;
  granularity: ReportGranularity;
  enabled: boolean;
  includeTrend?: boolean;
}) {
  const { activityId, anchorDate, granularity, enabled, includeTrend = true } = options;
  const timezone = useUserPreferences((s) => s.timezone);
  const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);

  return trpc.review.getReportActivityDetail.useQuery(
    { activityId, anchorDate, granularity, timezone, weekStartsOn, includeTrend },
    {
      enabled,
      // 同じ行を開き直した時に即座に出す。明細も分単位では動かない
      staleTime: 60_000,
    },
  );
}
