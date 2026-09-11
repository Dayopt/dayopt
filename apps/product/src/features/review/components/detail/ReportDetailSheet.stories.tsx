import {
  isMedianEligibleSource,
  summarizeDurationDistribution,
} from '../../domain/report/duration-distribution';
import { ReportDetailBody } from './ReportDetailBody';
import { ReportDetailSheet } from './ReportDetailSheet';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ReportActivityDetailResult } from '../../server/report-detail-service';

/**
 * アクティビティ詳細のボトムシート（モバイルの器。仕様 §8）。
 *
 * 中身はデスクトップのパネルと同じ `ReportDetailBody` で、**週別の推移だけ出さない**
 * （狭い面で 6 本の棒は読めない）。出さないぶんは取得側でも落としている。
 */
const meta = {
  title: 'Product/Features/Review/Detail/ReportDetailSheet',
  component: ReportDetailSheet,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
  },
  args: {
    open: true,
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    granularity: 'week' as const,
    timezone: 'Asia/Tokyo',
    isError: false,
    isPending: false,
    onClose: () => {},
  },
} satisfies Meta<typeof ReportDetailSheet>;

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
    // シートは推移を描かない。渡しても出ないことを Story でも示す
    trend: [
      { key: '2026-08-24', recordedMinutes: 180, medianBoxMinutes: 90 },
      { key: '2026-08-31', recordedMinutes: 600, medianBoxMinutes: 120 },
    ],
    // ストリップはシートにも出る（狭い面でも 1 本の軸なら読める）
    records: [
      {
        id: 'rec-1',
        title: '執筆',
        startAt: '2026-09-01T01:00:00.000Z',
        endAt: '2026-09-01T02:30:00.000Z',
        minutes: 90,
        fulfillment: 'high',
        note: null,
        source: 'manual',
      },
      {
        id: 'rec-2',
        title: '執筆',
        startAt: '2026-09-02T04:00:00.000Z',
        endAt: '2026-09-02T06:00:00.000Z',
        minutes: 120,
        fulfillment: null,
        note: 'メモ',
        source: 'manual',
      },
      {
        id: 'rec-3',
        title: '執筆',
        startAt: '2026-09-03T01:00:00.000Z',
        endAt: '2026-09-03T02:00:00.000Z',
        minutes: 60,
        fulfillment: 'low',
        note: null,
        source: 'manual',
      },
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

/** 既定（375x812）。統計 4 枚・鏡・時間帯・明細が縦に並ぶ。 */
export const Default: Story = { args: { detail: detail() } };

/** 記録が 1 件も無い期間。中央値はダッシュ、明細は空文言。 */
export const NoRecords: Story = {
  args: {
    detail: detail({
      recordedMinutes: 0,
      medianBoxMinutes: null,
      fulfillment: { low: 0, medium: 0, high: 0 },
      timeOfDay: [0, 0, 0, 0, 0, 0],
      records: [],
      trend: [],
    }),
  },
};

/** 最小幅（320px）。統計カードが 2 列のまま潰れない。 */
export const NarrowScreen: Story = {
  args: { detail: detail() },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
};

export const Loading: Story = { args: { detail: undefined, isPending: true } };

export const ErrorState: Story = { args: { detail: undefined, isError: true } };

/**
 * すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。
 *
 * 器（`Drawer`）は画面に固定されるので複数を同時に開けない。並べるのは**中身**
 * （`ReportDetailBody`、`showTrend={false}`）をシートと同じ幅に置いたもの。
 */
export const AllPatterns: Story = {
  args: { detail: detail() },
  render: function AllPatternsDetailSheet() {
    const base = {
      name: '執筆',
      categoryName: '仕事',
      color: 'blue',
      granularity: 'week' as const,
      timezone: 'Asia/Tokyo',
      isError: false,
      isPending: false,
      onClose: () => {},
      showTrend: false,
    };
    return (
      <div className="flex flex-wrap items-start gap-6 p-4">
        <Row label="通常（推移は出さない）">
          <Sheet>
            <ReportDetailBody {...base} detail={detail()} />
          </Sheet>
        </Row>
        <Row label="記録なし">
          <Sheet>
            <ReportDetailBody
              {...base}
              detail={detail({
                recordedMinutes: 0,
                medianBoxMinutes: null,
                fulfillment: { low: 0, medium: 0, high: 0 },
                timeOfDay: [0, 0, 0, 0, 0, 0],
                records: [],
                trend: [],
              })}
            />
          </Sheet>
        </Row>
        <Row label="最小幅（320px）">
          <div className="bg-card border-border-subtle flex w-[320px] flex-col gap-4 rounded-2xl border p-4">
            <ReportDetailBody {...base} detail={detail()} />
          </div>
        </Row>
        <Row label="読み込み中">
          <Sheet>
            <ReportDetailBody {...base} detail={undefined} isPending />
          </Sheet>
        </Row>
        <Row label="エラー">
          <Sheet>
            <ReportDetailBody {...base} detail={undefined} isError />
          </Sheet>
        </Row>
      </div>
    );
  },
};

/** 本番のボトムシートと同じ幅の器。 */
function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border-border-subtle flex w-[375px] flex-col gap-4 rounded-2xl border p-4">
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
