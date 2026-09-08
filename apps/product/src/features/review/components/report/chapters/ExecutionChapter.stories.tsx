import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ExecutionChapter } from './ExecutionChapter';

import type { ReportExecutionRow, ReportMirrorRow } from '../../../domain/report/report-view-model';

/**
 * 2 章「執行 — 計画どおりだったか」。
 *
 * 行は**足切りしない**。予定は塗らずに破線で置き、過去予定が 15 分に満たない行では
 * 比率そのものを出さない（数えるに足りない回数で率を作らない）。
 */
const meta = {
  title: 'Product/Features/Review/Chapters/Execution',
  component: ExecutionChapter,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ExecutionChapter>;

export default meta;
type Story = StoryObj<typeof meta>;

function row(overrides: Partial<ReportExecutionRow> = {}): ReportExecutionRow {
  return {
    activityId: 'act-write',
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    archived: false,
    recordedMinutes: 600,
    plannedMinutes: 480,
    plannedPastMinutes: 480,
    recordedRatio: 1,
    plannedRatio: 0.8,
    planRatioPercent: 125,
    ...overrides,
  };
}

const ROWS: ReportExecutionRow[] = [
  row(),
  row({
    activityId: 'act-read',
    name: '読書',
    color: 'green',
    recordedMinutes: 320,
    plannedMinutes: 360,
    plannedPastMinutes: 360,
    recordedRatio: 0.53,
    plannedRatio: 0.6,
    planRatioPercent: 89,
  }),
  // 過去予定が 15 分未満（= 未来の予定しか無い）。比率は出さずダッシュのまま
  row({
    activityId: 'act-gym',
    name: '運動',
    color: 'orange',
    recordedMinutes: 180,
    plannedMinutes: 240,
    plannedPastMinutes: 0,
    recordedRatio: 0.3,
    plannedRatio: 0.4,
    planRatioPercent: null,
  }),
  // 予定を置かずに記録だけした行。破線は描かない
  row({
    activityId: null,
    name: null,
    color: null,
    recordedMinutes: 90,
    plannedMinutes: 0,
    plannedPastMinutes: 0,
    recordedRatio: 0.15,
    plannedRatio: null,
    planRatioPercent: null,
  }),
];

const MIRROR_ROWS: ReportMirrorRow[] = [
  {
    activityId: 'act-write',
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    coefficient: 1.31,
    tone: 'over',
  },
  {
    activityId: 'act-mail',
    name: 'メール',
    categoryName: '仕事',
    color: 'violet',
    coefficient: 0.72,
    tone: 'under',
  },
  {
    activityId: 'act-read',
    name: '読書',
    categoryName: '学習',
    color: 'green',
    coefficient: 0.98,
    tone: 'onPlan',
  },
];

export const Default: Story = {
  args: { granularity: 'week', rows: ROWS, mirrorRows: MIRROR_ROWS },
};

export const Mobile: Story = {
  args: { granularity: 'week', rows: ROWS, mirrorRows: MIRROR_ROWS },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** 鏡の候補が 1 件だけの週。並べられるものだけ並べる。 */
export const SingleMirrorRow: Story = {
  args: { granularity: 'week', rows: ROWS, mirrorRows: [MIRROR_ROWS[0] as ReportMirrorRow] },
};

/** 予実のペアがまだ無い週。鏡は空文言で黙る。 */
export const NoMirrorRows: Story = { args: { granularity: 'week', rows: ROWS, mirrorRows: [] } };

/** 記録も予定も無い週。 */
export const Empty: Story = { args: { granularity: 'week', rows: [], mirrorRows: [] } };

/** 行が多い週。カード内スクロールにせず素直に伸ばす（決算の完全性）。 */
export const ManyRows: Story = {
  args: {
    granularity: 'week',
    rows: Array.from({ length: 18 }, (_, index) =>
      row({
        activityId: `act-${index}`,
        name: `アクティビティ ${index + 1}`,
        color: ['blue', 'green', 'orange', 'violet', 'red'][index % 5] ?? 'blue',
        recordedMinutes: 600 - index * 30,
        plannedMinutes: 480 - index * 20,
        plannedPastMinutes: 480 - index * 20,
        recordedRatio: (600 - index * 30) / 600,
        plannedRatio: (480 - index * 20) / 600,
        planRatioPercent: Math.round(((600 - index * 30) / (480 - index * 20)) * 100),
      }),
    ),
    mirrorRows: MIRROR_ROWS,
  },
};

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。 */
export const AllPatterns: Story = {
  args: { granularity: 'week', rows: ROWS, mirrorRows: MIRROR_ROWS },
  render: function AllPatternsExecution() {
    return (
      <div className="flex flex-col gap-6">
        <Row label="通常（鏡 3 件）">
          <ExecutionChapter granularity="week" rows={ROWS} mirrorRows={MIRROR_ROWS} />
        </Row>
        <Row label="鏡が 1 件だけ">
          <ExecutionChapter
            granularity="week"
            rows={ROWS}
            mirrorRows={[MIRROR_ROWS[0] as ReportMirrorRow]}
          />
        </Row>
        <Row label="鏡の候補なし（閾値未満で黙る）">
          <ExecutionChapter granularity="week" rows={ROWS} mirrorRows={[]} />
        </Row>
        <Row label="空（記録も予定も無い）">
          <ExecutionChapter granularity="week" rows={[]} mirrorRows={[]} />
        </Row>
        <Row label="月粒度">
          <ExecutionChapter granularity="month" rows={ROWS} mirrorRows={MIRROR_ROWS} />
        </Row>
        <Row label="狭い面（320px）">
          <div className="w-[320px]">
            <ExecutionChapter granularity="week" rows={ROWS} mirrorRows={MIRROR_ROWS} />
          </div>
        </Row>
      </div>
    );
  },
};

function Row({ children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}
