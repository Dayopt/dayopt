'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo } from 'react';

import { ErrorState } from '@/components/ui/feedback/ErrorState';
import { Skeleton } from '@dayopt/components';

import {
  applySegmentLens,
  buildAllocationSlices,
  buildCompassPoints,
  buildCompassWaitingList,
  buildExecutionRows,
  buildInkColumns,
  buildMirrorRows,
  buildSegmentBars,
  computeDenominators,
  computePreviousDelta,
  computeUncategorizedPercent,
  maxInkColumnMinutes,
  resolveVisibleActivities,
} from '../../domain/report/report-view-model';
import { useActiveSegment } from '../../hooks/useActiveSegment';
import { useReportPeriod } from '../../hooks/useReportPeriod';
import { useReviewOpenedTracking } from '../../hooks/useReviewOpenedTracking';
import { useSegments } from '../../hooks/useSegments';
import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { useReportViewStore } from '../../stores/useReportViewStore';
import { AllocationChapter } from './chapters/AllocationChapter';
import { ExecutionChapter } from './chapters/ExecutionChapter';
import { QualityChapter } from './chapters/QualityChapter';
import { TidyChapter } from './chapters/TidyChapter';

import type { ReportFilterState } from '../../domain/report/report-view-model';
import type { ReportGranularity } from '../../lib/report-period';

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
  /**
   * 4 章からカレンダーへ飛ぶ 3 つの導線（仕様 §7）。
   *
   * **遷移そのものは review が持たない。** `useRouter` を本体で呼ぶと、`/report` 以外から
   * 描かれた時（Storybook・単体 test）に intl / router context を要求してしまう。期間の解釈と
   * 同じく、ルーティングは Composition Bridge（`ReportViewClient`）の仕事にする。
   */
  onJumpToRecord: (target: { id: string; dayKey: string }) => void;
  onJumpToDay: (dayKey: string) => void;
  onJumpToNextPeriod: () => void;
}

/**
 * `/report` の本体（1 スクロール構成）。
 *
 * 章は決まった順に並び、折りたたみ・並び替え・非表示は持たない（仕様 §0-1）。
 * 4 章まで揃っている。
 *
 * フィルタ（カテゴリー / 未分類 / 余白）とセグメントレンズは `useReportViewStore`
 * （端末ローカル）から読む。派生はすべて client の純粋関数で、トグルのたびに
 * サーバーへ往復しない（#2576 の設計）。
 */
export function ReportBody({
  anchorDate,
  granularity,
  onJumpToDay,
  onJumpToNextPeriod,
  onJumpToRecord,
}: ReportBodyProps) {
  const t = useTranslations('report.errors');
  useReviewOpenedTracking(true);

  const { data, isPending, isError } = useReportPeriod(anchorDate, granularity);

  // 行・点から詳細パネルを開く。パネル本体は Composition Bridge が描く（review 本体に
  // tRPC query を持ち込むと、`/report` 以外から描いた時に context を要求してしまう）
  // 器（デスクトップのパネル / モバイルのシート）は Composition Bridge が選ぶので、
  // 開く口はどの面でも常に渡す（#2582 まではモバイルに器が無く、slot の有無で塞いでいた）
  const selectActivity = useReportDetailStore((state) => state.toggle);
  const closeDetail = useReportDetailStore((state) => state.close);

  // 期間を移したら閉じる（仕様 §5）。別の期間の明細を開いたまま残さない
  useEffect(() => {
    closeDetail();
  }, [anchorDate, granularity, closeDetail]);
  const { data: segments } = useSegments();

  // オブジェクトを返す selector は毎 render で新しい参照になるため、値ごとに読む
  const hiddenCategoryIds = useReportViewStore((state) => state.hiddenCategoryIds);
  const uncategorizedHidden = useReportViewStore((state) => state.uncategorizedHidden);
  const marginHidden = useReportViewStore((state) => state.marginHidden);

  // 削除済みセグメントの縮退と解決待ちの判定は hook が持つ（サイドバーと同じ答えを使う）
  const { activeSegment, isResolving } = useActiveSegment();

  const view = useMemo(() => {
    if (!data) return null;

    const filter: ReportFilterState = { hiddenCategoryIds, uncategorizedHidden, marginHidden };
    const visible = resolveVisibleActivities(data.activities, filter);
    const lensed = applySegmentLens(visible, activeSegment?.activityIds ?? null);

    // レンズ中は余白を分母に入れない。セグメント内の記録合計が 100% になる（仕様 §2.4）
    const marginVisible = !marginHidden && activeSegment === null;

    const denominators = computeDenominators({
      // ここにフィルタを掛けてはいけない。掛けると余白がフィルタで動く（仕様 §13-2）
      allActivities: data.activities,
      visibleActivities: lensed,
      lengthMinutes: data.period.lengthMinutes,
      marginVisible,
    });
    const inkColumns = buildInkColumns(lensed, data.period.bucketKeys);

    return {
      denominators,
      marginVisible,
      inkColumns,
      maxInkMinutes: maxInkColumnMinutes(inkColumns),
      slices: buildAllocationSlices(
        lensed,
        denominators.trackMinutes,
        activeSegment === null ? 'category' : 'activity',
      ),
      // レンズ中はブロックごと描かない（選択中 100% / 他 ~0% は読み違いを生む）。
      // 計算はレンズ前の集合で行う — レンズ後だと選択中のセグメントしか値を持たない
      segmentBars:
        activeSegment === null
          ? buildSegmentBars(visible, segments ?? [], denominators.trackMinutes)
          : [],
      // 2〜4 章もフィルタとレンズを効かせるので、1 章と同じ `lensed` を渡す。
      // `computeDenominators` の `allActivities` だけがフィルタ前（仕様 §13-2）
      executionRows: buildExecutionRows(lensed),
      mirrorRows: buildMirrorRows(lensed),
      compassPoints: buildCompassPoints(lensed),
      waitingActivities: buildCompassWaitingList(lensed),
      uncategorizedPercent: computeUncategorizedPercent(lensed, denominators.visibleMinutes),
      previousDeltaMinutes: computePreviousDelta({
        visibleMinutes: denominators.visibleMinutes,
        previousActivities: data.previousActivities,
        visibleActivityIds: new Set(lensed.map((activity) => activity.activityId)),
      }),
    };
  }, [data, segments, activeSegment, hiddenCategoryIds, uncategorizedHidden, marginHidden]);

  if (isError) {
    return (
      <div className={REPORT_BODY_CONTAINER}>
        <ErrorState title={t('title')} description={t('description')} />
      </div>
    );
  }

  // レンズの生死が決まる前に数字を出すと、非レンズの分母が一瞬見えてしまう
  if (isPending || isResolving || !view) {
    return (
      <div className={REPORT_BODY_CONTAINER}>
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className={REPORT_BODY_CONTAINER}>
      <AllocationChapter
        granularity={granularity}
        denominators={view.denominators}
        slices={view.slices}
        segmentBars={view.segmentBars}
        inkColumns={view.inkColumns}
        maxInkMinutes={view.maxInkMinutes}
        uncategorizedPercent={view.uncategorizedPercent}
        previousDeltaMinutes={view.previousDeltaMinutes}
        marginVisible={view.marginVisible}
        activeSegmentName={activeSegment?.name ?? null}
      />

      <ExecutionChapter
        granularity={granularity}
        mirrorRows={view.mirrorRows}
        onSelectActivity={selectActivity}
        rows={view.executionRows}
      />

      <QualityChapter
        onSelectActivity={selectActivity}
        points={view.compassPoints}
        waitingActivities={view.waitingActivities}
      />

      <TidyChapter
        granularity={granularity}
        nextPeriodPlannedMinutes={data.nextPeriodPlannedMinutes}
        onOpenNextPeriod={onJumpToNextPeriod}
        onReviewExternalEvents={() => {
          // 件数が 0 ならボタン自体が出ないが、集計とジャンプ先は同じ query の結果なので
          // 念のため null を握る（押した先に何も無い日を開かない）
          if (data.firstUnconvertedExternalEvent === null) return;
          onJumpToDay(data.firstUnconvertedExternalEvent.dayKey);
        }}
        onSortUncategorized={() => {
          if (data.firstUncategorizedRecord === null) return;
          onJumpToRecord(data.firstUncategorizedRecord);
        }}
        uncategorizedRecordCount={data.uncategorizedRecordCount}
        unconvertedExternalEventCount={data.unconvertedExternalEventCount}
      />
    </div>
  );
}
