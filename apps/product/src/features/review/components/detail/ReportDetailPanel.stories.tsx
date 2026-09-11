import { useEffect, useState } from 'react';

import { setDomSlot } from '@/lib/dom-slots/useDomSlot';

import {
  isMedianEligibleSource,
  summarizeDurationDistribution,
} from '../../domain/report/duration-distribution';
import { REPORT_DETAIL_SLOT_KEY } from '../../lib/report-detail-slot';
import { ReportDetailBody } from './ReportDetailBody';
import { ReportDetailPanel } from './ReportDetailPanel';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ReportActivityDetailResult } from '../../server/report-detail-service';

/**
 * アクティビティ詳細パネル（仕様 §6）。
 *
 * 本番では shell が用意する 4 カラム目へ portal する。Story では同じ幅の器を用意して、
 * その中へ描く。**パネル内に編集 UI は無い**（充実の後付けは編集面の仕事）。
 */
const meta = {
  title: 'Product/Features/Review/Detail/ReportDetailPanel',
  component: ReportDetailPanel,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      const [slot, setSlot] = useState<HTMLDivElement | null>(null);

      useEffect(() => {
        setDomSlot(REPORT_DETAIL_SLOT_KEY, slot);
        return () => setDomSlot(REPORT_DETAIL_SLOT_KEY, null);
      }, [slot]);

      return (
        <div
          ref={setSlot}
          className="border-border-subtle h-[600px] w-[360px] overflow-hidden rounded-2xl border"
        >
          <Story />
        </div>
      );
    },
  ],
  args: {
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    granularity: 'week' as const,
    timezone: 'Asia/Tokyo',
    isError: false,
    isPending: false,
    onClose: () => {},
    onOpenCalendarDay: () => {},
  },
} satisfies Meta<typeof ReportDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function detail(overrides: Partial<ReportActivityDetailResult> = {}): ReportActivityDetailResult {
  const base: ReportActivityDetailResult = {
    recordedMinutes: 600,
    plannedMinutes: 480,
    plannedPastMinutes: 480,
    plannedPastBoxes: 4,
    medianBoxMinutes: 90,
    medianPlanBoxMinutes: 60,
    fulfillment: { low: 1, medium: 2, high: 3 },
    timeOfDay: [60, 240, 120, 180, 0, 0],
    trend: [
      { key: '2026-08-03', recordedMinutes: 240, medianBoxMinutes: 60 },
      { key: '2026-08-10', recordedMinutes: 300, medianBoxMinutes: 75 },
      { key: '2026-08-17', recordedMinutes: 420, medianBoxMinutes: 105 },
      { key: '2026-08-24', recordedMinutes: 180, medianBoxMinutes: 90 },
      { key: '2026-08-31', recordedMinutes: 600, medianBoxMinutes: 90 },
      { key: '2026-09-07', recordedMinutes: 0, medianBoxMinutes: null },
    ],
    records: [
      record('rec-1', '2026-09-01T01:00:00.000Z', 30, { fulfillment: 'high' }),
      record('rec-2', '2026-09-02T04:00:00.000Z', 45),
      record('rec-3', '2026-09-03T00:00:00.000Z', 60, { fulfillment: 'low', note: 'メモ' }),
      record('rec-4', '2026-09-04T01:00:00.000Z', 60),
      record('rec-5', '2026-09-05T02:00:00.000Z', 90, { fulfillment: 'medium' }),
      record('rec-6', '2026-09-06T01:00:00.000Z', 90),
      record('rec-7', '2026-09-07T02:00:00.000Z', 120),
      record('rec-8', '2026-09-08T01:00:00.000Z', 240, { fulfillment: 'low' }),
    ],
    durationDistribution: null,
    ...overrides,
  };

  return {
    ...base,
    durationDistribution: overrides.durationDistribution ?? distributionOf(base.records),
  };
}

/**
 * 分布は server が全件から出す。fixture でも同じ規則（auto_migrated を除く）で作り、
 * 「明細と分布が別物」の状態を誤って固定しないようにする。
 */
function distributionOf(
  records: ReportActivityDetailResult['records'],
): ReportActivityDetailResult['durationDistribution'] {
  return summarizeDurationDistribution(
    records.filter((row) => isMedianEligibleSource(row.source)).map((row) => row.minutes),
  );
}

/** 明細 1 件。ストリップの点が分かれて見えるよう長さをばらけさせる。 */
function record(
  id: string,
  startAt: string,
  minutes: number,
  overrides: Partial<ReportActivityDetailResult['records'][number]> = {},
): ReportActivityDetailResult['records'][number] {
  return {
    id,
    title: '執筆',
    startAt,
    endAt: new Date(Date.parse(startAt) + minutes * 60_000).toISOString(),
    minutes,
    fulfillment: null,
    note: null,
    source: 'manual',
    ...overrides,
  };
}

export const Default: Story = { args: { detail: detail() } };

/** 推移に出せる期間が 2 未満。節ごと消える（仕様 §6-5）。 */
export const WithoutTrend: Story = {
  args: {
    detail: detail({
      trend: [
        { key: 'a', recordedMinutes: 0, medianBoxMinutes: null },
        { key: 'b', recordedMinutes: 0, medianBoxMinutes: null },
        { key: 'c', recordedMinutes: 600, medianBoxMinutes: 120 },
      ],
    }),
  },
};

/** 記録が 1 件も無い期間。中央値はダッシュ、明細は空文言。 */
export const NoRecords: Story = {
  args: {
    detail: detail({
      recordedMinutes: 0,
      medianBoxMinutes: null,
      medianPlanBoxMinutes: null,
      fulfillment: { low: 0, medium: 0, high: 0 },
      timeOfDay: [0, 0, 0, 0, 0, 0],
      records: [],
      trend: [],
    }),
  },
};

/** 充実に 1 件も回答がない。カードは「未回答」。 */
export const Unanswered: Story = {
  args: { detail: detail({ fulfillment: { low: 0, medium: 0, high: 0 } }) },
};

/** 予定はあるがまだ来ていない（過去予定が閾値未満）。率を作らない。 */
export const PlanNotDue: Story = {
  args: { detail: detail({ plannedPastMinutes: 0, plannedPastBoxes: 0, plannedMinutes: 240 }) },
};

/** アクティビティ未設定の記録をまとめて見る。 */
export const Unassigned: Story = {
  args: { name: null, categoryName: null, color: null, detail: detail() },
};

/** ストリップに出せる記録が 3 件未満。分布は作らず件数不足とだけ言う。 */
export const NotEnoughForStrip: Story = {
  args: {
    detail: detail({
      records: [
        record('rec-1', '2026-09-01T01:00:00.000Z', 45),
        record('rec-2', '2026-09-02T01:00:00.000Z', 90),
      ],
    }),
  },
};

/** 自動移行の記録が混ざる。明細には残るが、点と中央値には数えない。 */
export const WithAutoMigrated: Story = {
  args: {
    detail: detail({
      records: [
        record('rec-1', '2026-09-01T01:00:00.000Z', 45),
        record('rec-2', '2026-09-02T01:00:00.000Z', 60),
        record('rec-3', '2026-09-03T01:00:00.000Z', 90),
        record('rec-migrated', '2026-09-04T01:00:00.000Z', 480, { source: 'auto_migrated' }),
      ],
    }),
  },
};

/** 過去の予定が 1 件も無い。▲ を出さない。 */
export const WithoutPlanMedian: Story = {
  args: { detail: detail({ medianPlanBoxMinutes: null }) },
};

export const Loading: Story = { args: { detail: undefined, isPending: true } };

export const ErrorState: Story = { args: { detail: undefined, isError: true } };

/**
 * すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。
 *
 * 器（`ReportDetailPanel`）は shell の 1 つの slot へ portal するので、複数を並べると
 * 同じ器に積み上がって読めない。並べるのは**中身**（`ReportDetailBody`）を器と同じ
 * 既定幅（360px）に置いたもの。器そのものの見え方と幅の変更は `Default` を見る。
 */
export const AllPatterns: Story = {
  args: { detail: detail() },
  render: function AllPatternsDetailPanel() {
    const base = {
      name: '執筆',
      categoryName: '仕事',
      color: 'blue',
      granularity: 'week' as const,
      timezone: 'Asia/Tokyo',
      isError: false,
      isPending: false,
      onClose: () => {},
      onOpenCalendarDay: () => {},
      showTrend: true,
    };
    return (
      <div className="flex flex-wrap items-start gap-6">
        <Row label="通常">
          <Panel>
            <ReportDetailBody {...base} detail={detail()} />
          </Panel>
        </Row>
        <Row label="推移なし（データのある期間が 2 未満）">
          <Panel>
            <ReportDetailBody
              {...base}
              detail={detail({
                trend: [
                  { key: 'a', recordedMinutes: 0, medianBoxMinutes: null },
                  { key: 'b', recordedMinutes: 0, medianBoxMinutes: null },
                  { key: 'c', recordedMinutes: 600, medianBoxMinutes: 120 },
                ],
              })}
            />
          </Panel>
        </Row>
        <Row label="記録なし（中央値はダッシュ）">
          <Panel>
            <ReportDetailBody
              {...base}
              detail={detail({
                recordedMinutes: 0,
                medianBoxMinutes: null,
                medianPlanBoxMinutes: null,
                fulfillment: { low: 0, medium: 0, high: 0 },
                timeOfDay: [0, 0, 0, 0, 0, 0],
                records: [],
                trend: [],
              })}
            />
          </Panel>
        </Row>
        <Row label="予定が未消化（率を作らない）">
          <Panel>
            <ReportDetailBody
              {...base}
              detail={detail({ plannedPastMinutes: 0, plannedPastBoxes: 0, plannedMinutes: 240 })}
            />
          </Panel>
        </Row>
        <Row label="アクティビティ未設定">
          <Panel>
            <ReportDetailBody
              {...base}
              name={null}
              categoryName={null}
              color={null}
              detail={detail()}
            />
          </Panel>
        </Row>
        <Row label="ストリップに出せる記録が 3 件未満">
          <Panel>
            <ReportDetailBody
              {...base}
              detail={detail({
                records: [
                  record('rec-1', '2026-09-01T01:00:00.000Z', 45),
                  record('rec-2', '2026-09-02T01:00:00.000Z', 90),
                ],
              })}
            />
          </Panel>
        </Row>
        <Row label="自動移行を含む（点にはしない）">
          <Panel>
            <ReportDetailBody
              {...base}
              detail={detail({
                records: [
                  record('rec-1', '2026-09-01T01:00:00.000Z', 45),
                  record('rec-2', '2026-09-02T01:00:00.000Z', 60),
                  record('rec-3', '2026-09-03T01:00:00.000Z', 90),
                  record('rec-migrated', '2026-09-04T01:00:00.000Z', 480, {
                    source: 'auto_migrated',
                  }),
                ],
              })}
            />
          </Panel>
        </Row>
        <Row label="予定の中央値なし（▲ を出さない）">
          <Panel>
            <ReportDetailBody {...base} detail={detail({ medianPlanBoxMinutes: null })} />
          </Panel>
        </Row>
        <Row label="読み込み中">
          <Panel>
            <ReportDetailBody {...base} detail={undefined} isPending />
          </Panel>
        </Row>
        <Row label="エラー">
          <Panel>
            <ReportDetailBody {...base} detail={undefined} isError />
          </Panel>
        </Row>
      </div>
    );
  },
};

/** 本番の 4 カラム目と同じ既定幅（360px）の器。 */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-border-subtle flex h-[560px] w-[360px] flex-col gap-4 overflow-y-auto rounded-2xl border p-4">
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      {children}
    </div>
  );
}
