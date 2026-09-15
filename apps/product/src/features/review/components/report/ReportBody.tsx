'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo } from 'react';

import { ErrorState } from '@/components/ui/feedback/ErrorState';
import { Skeleton } from '@dayopt/components';

import {
  buildActivityUsageRows,
  buildAllocationSlices,
  buildCompassPoints,
  buildCompassWaitingList,
  buildDurationBins,
  buildExecutionRows,
  buildHourTotals,
  buildInkColumns,
  buildMirrorRows,
  buildUsageSummary,
  computeDenominators,
  mergeDurationCounts,
  normalizeReportPeriodPayload,
  resolveAllocationMode,
  resolveVisibleActivities,
} from '../../domain/report/report-view-model';
import { useReportPeriod } from '../../hooks/useReportPeriod';
import { useReviewOpenedTracking } from '../../hooks/useReviewOpenedTracking';
import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { useReportViewStore } from '../../stores/useReportViewStore';
import { AllocationChapter } from './chapters/AllocationChapter';
import { ExecutionChapter } from './chapters/ExecutionChapter';
import { QualityChapter } from './chapters/QualityChapter';

import type { ReportFilterState } from '../../domain/report/report-view-model';
import type { ReportGranularity } from '../../lib/report-period';
import type { ReportTab } from '../../lib/report-tab';

/**
 * 本文の外枠。
 *
 * **最大幅を持たせない**（2026-09-07 User 指示）。以前は `mx-auto max-w-2xl` で
 * 中央に細く置いていたが、広い画面では左右に大きな空きができて盤面だけが痩せて
 * 見えていた。横は与えられた幅いっぱいまで使う。
 *
 * 左右の padding（`p-4 md:p-6`）は残す。端まで詰めると章のカードが画面の縁に
 * 貼り付く。
 *
 * 読み込み・エラーの分岐も同じ枠を使う。枠が違うと、解決した瞬間に横位置が跳ねる。
 */
const REPORT_BODY_CONTAINER = 'flex w-full flex-col gap-8 p-4 md:p-6';

interface ReportBodyProps {
  anchorDate: string;
  granularity: ReportGranularity;
  /** 描く面。タブの UI と URL は Composition Bridge（`ReportViewClient`）が持つ。 */
  tab: ReportTab;
}

/**
 * `/report` の本体。タブごとに 1 つの面を描く。
 *
 * | tab       | 面                                         |
 * | --------- | ------------------------------------------ |
 * | `usage`   | 時間の使い方（記録時間・日別・配分・一覧）     |
 * | `diff`    | 執行（記録 / 予定のバーと見積もりの鏡）    |
 * | `reflect` | 質（羅針盤と待機リスト）                   |
 *
 * **集計は 1 回だけ。** 期間の query と派生はタブに依存させず、描く面だけを切り替える。
 * タブを行き来してもサーバーへ往復せず、フィルタの効き方もタブ間で揃う。
 *
 * フィルタ（カテゴリー / アクティビティ）は `useReportViewStore`
 * （端末ローカル）から読む。派生はすべて client の純粋関数で、トグルのたびに
 * サーバーへ往復しない（#2576 の設計）。
 */
export function ReportBody({ anchorDate, granularity, tab }: ReportBodyProps) {
  const t = useTranslations('report.errors');
  useReviewOpenedTracking(true);

  const { data, isPending, isError } = useReportPeriod(anchorDate, granularity);

  // 行・点から詳細パネルを開く。パネル本体は Composition Bridge が描く（review 本体に
  // tRPC query を持ち込むと、`/report` 以外から描いた時に context を要求してしまう）
  // 器（デスクトップのパネル / モバイルのシート）は Composition Bridge が選ぶので、
  // 開く口はどの面でも常に渡す（#2582 まではモバイルに器が無く、slot の有無で塞いでいた）
  const selectActivity = useReportDetailStore((state) => state.toggle);
  const closeDetail = useReportDetailStore((state) => state.close);

  // 期間を移したら閉じる（仕様 §6）。別の期間の明細を開いたまま残さない。
  // **タブ切替では閉じない** — 同じ期間・同じアクティビティの明細は、どの面から見ても同じ答え
  useEffect(() => {
    closeDetail();
  }, [anchorDate, granularity, closeDetail]);

  // オブジェクトを返す selector は毎 render で新しい参照になるため、値ごとに読む
  const hiddenCategoryIds = useReportViewStore((state) => state.hiddenCategoryIds);
  const hiddenActivityIds = useReportViewStore((state) => state.hiddenActivityIds);

  const view = useMemo(() => {
    if (!data) return null;
    // 永続化 cache から古い形の集計が復元されても落とさない（足りない項目を空で補う）
    const payload = normalizeReportPeriodPayload(data);

    const filter: ReportFilterState = {
      hiddenCategoryIds,
      hiddenActivityIds,
    };
    const visible = resolveVisibleActivities(payload.activities, filter);
    const denominators = computeDenominators({
      // ここにフィルタを掛けてはいけない。掛けると余白がフィルタで動く（仕様 §10 の 13-2）
      allActivities: payload.activities,
      visibleActivities: visible,
      lengthMinutes: payload.period.lengthMinutes,
    });
    const allocationMode = resolveAllocationMode(visible);

    return {
      denominators,
      summary: buildUsageSummary(visible, payload.previousActivities),
      columns: buildInkColumns(visible, payload.period.bucketKeys),
      hourTotals: buildHourTotals(visible),
      durationBins: buildDurationBins(
        mergeDurationCounts(visible.map((activity) => activity.durationCounts)),
      ),
      allocation: {
        mode: allocationMode,
        slices:
          allocationMode === 'none'
            ? []
            : buildAllocationSlices(visible, denominators.trackMinutes, allocationMode),
      },
      usageRows: buildActivityUsageRows(visible, payload.previousActivities),
      // どのタブも同じ `visible` を渡す。`computeDenominators` の `allActivities` だけがフィルタ前
      executionRows: buildExecutionRows(visible),
      mirrorRows: buildMirrorRows(visible),
      compassPoints: buildCompassPoints(visible),
      waitingActivities: buildCompassWaitingList(visible),
    };
  }, [data, hiddenCategoryIds, hiddenActivityIds]);

  if (isError) {
    return (
      <div className={REPORT_BODY_CONTAINER}>
        <ErrorState title={t('title')} description={t('description')} />
      </div>
    );
  }

  if (isPending || !view) {
    return (
      <div className={REPORT_BODY_CONTAINER}>
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className={REPORT_BODY_CONTAINER} data-report-tab-panel={tab}>
      {tab === 'usage' && (
        <AllocationChapter
          granularity={granularity}
          summary={view.summary}
          marginMinutes={view.denominators.marginMinutes}
          columns={view.columns}
          allocation={view.allocation}
          hourTotals={view.hourTotals}
          durationBins={view.durationBins}
          usageRows={view.usageRows}
          onSelectActivity={selectActivity}
        />
      )}

      {tab === 'diff' && (
        <ExecutionChapter
          granularity={granularity}
          mirrorRows={view.mirrorRows}
          onSelectActivity={selectActivity}
          rows={view.executionRows}
        />
      )}

      {tab === 'reflect' && (
        <QualityChapter
          onSelectActivity={selectActivity}
          points={view.compassPoints}
          waitingActivities={view.waitingActivities}
        />
      )}
    </div>
  );
}
