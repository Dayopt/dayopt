import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AllocationChapter } from './AllocationChapter';

import type {
  ReportActivityUsageRow,
  ReportAllocationSlice,
  ReportDurationBin,
  ReportInkColumn,
} from '../../../domain/report/report-view-model';

/**
 * 時間の使い方の面。
 *
 * 上段に数字のカード 3 枚（記録時間 / 件数 / 1 件の中央値）。下段は広い幅で 2 列:
 * 左に日ごとの記録時間とアクティビティ一覧、右に配分と 2 つの分布。狭い幅では 1 列に積む。
 * 増減は矢印と符号だけで示し、良し悪しの色を付けない。
 */
const meta = {
  title: 'Product/Features/Review/Chapters/Allocation',
  component: AllocationChapter,
  parameters: { layout: 'padded' },
  argTypes: {
    granularity: { control: 'radio', options: ['week', 'month', 'year'] },
  },
} satisfies Meta<typeof AllocationChapter>;

export default meta;
type Story = StoryObj<typeof meta>;

const WEEK_KEYS = [
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-19',
  '2026-09-20',
];
const DAILY_MINUTES = [260, 230, 380, 250, 330, 160, 80];

const COLUMNS: ReportInkColumn[] = WEEK_KEYS.map((key, index) => ({
  key,
  stacks: [{ key: 'c1', label: '開発', color: 'blue', minutes: DAILY_MINUTES[index] ?? 0 }],
  totalMinutes: DAILY_MINUTES[index] ?? 0,
}));

/** 記録の合計 1720 分を 100% にした区画。 */
const SLICES: ReportAllocationSlice[] = [
  { key: 'c1', label: '開発', color: 'blue', icon: null, minutes: 720, percent: 42 },
  { key: 'c2', label: '仕事', color: 'orange', icon: null, minutes: 380, percent: 22 },
  { key: 'c3', label: 'プライベート', color: 'violet', icon: null, minutes: 250, percent: 15 },
  { key: 'c4', label: '自己投資', color: 'green', icon: null, minutes: 200, percent: 12 },
  { key: 'c5', label: 'ミーティング', color: 'pink', icon: null, minutes: 130, percent: 8 },
  { key: '__uncategorized', label: null, color: null, icon: null, minutes: 40, percent: 2 },
];

const HOURS = [
  0, 0, 0, 0, 0, 0, 10, 20, 60, 110, 140, 120, 60, 150, 180, 170, 140, 110, 70, 60, 40, 30, 20, 10,
];

const BINS: ReportDurationBin[] = [
  { fromMinutes: 0, toMinutes: 5, count: 6 },
  { fromMinutes: 5, toMinutes: 10, count: 18 },
  { fromMinutes: 10, toMinutes: 15, count: 22 },
  { fromMinutes: 15, toMinutes: 30, count: 16 },
  { fromMinutes: 30, toMinutes: 45, count: 9 },
  { fromMinutes: 45, toMinutes: 60, count: 6 },
  { fromMinutes: 60, toMinutes: 90, count: 4 },
  { fromMinutes: 90, toMinutes: 120, count: 2 },
  { fromMinutes: 120, toMinutes: null, count: 1 },
];

const ROWS: ReportActivityUsageRow[] = [
  row('act-api', 'API開発', '開発', 'blue', 440, 18, 18, 90),
  row('act-front', 'フロントエンド開発', '開発', 'sky', 280, 16, 14, -70),
  row('act-mtg', 'ミーティング', 'ミーティング', 'pink', 130, 8, 16, 30),
  row('act-design', '設計・調査', '仕事', 'orange', 90, 6, 15, -20),
  row('act-study', '学習', '自己投資', 'green', 80, 5, 16, 10),
  row('act-read', '読書', '自己投資', 'green', 70, 4, 15, 40),
  row(null, null, null, null, 50, 3, 12, -10),
];

const BASE_ARGS = {
  granularity: 'week' as const,
  summary: {
    current: { recordedMinutes: 1720, recordCount: 84, medianMinutes: 12 },
    previous: { recordedMinutes: 1909, recordCount: 72, medianMinutes: 15 },
  },
  marginMinutes: 8360,
  columns: COLUMNS,
  allocation: { mode: 'category' as const, slices: SLICES },
  hourTotals: HOURS,
  durationBins: BINS,
  usageRows: ROWS,
  onSelectActivity: () => {},
};

export const Default: Story = { args: BASE_ARGS };

/** 1 つのカテゴリーだけを見ている状態。配分は配下のアクティビティ別に割れる。 */
export const ActivityBreakdown: Story = {
  args: {
    ...BASE_ARGS,
    summary: {
      current: { recordedMinutes: 720, recordCount: 34, medianMinutes: 16 },
      previous: { recordedMinutes: 700, recordCount: 30, medianMinutes: 16 },
    },
    allocation: {
      mode: 'activity',
      slices: [
        { key: 'act-api', label: 'API開発', color: 'blue', icon: null, minutes: 440, percent: 61 },
        {
          key: 'act-front',
          label: 'フロントエンド開発',
          color: 'blue',
          icon: null,
          minutes: 280,
          percent: 39,
        },
      ],
    },
    usageRows: ROWS.filter((r) => r.categoryName === '開発'),
  },
};

/** アクティビティ 1 つだけ。自分自身の 100% は出さず、配分のブロックを省く。 */
export const SingleActivity: Story = {
  args: {
    ...BASE_ARGS,
    summary: {
      current: { recordedMinutes: 440, recordCount: 18, medianMinutes: 18 },
      previous: { recordedMinutes: 350, recordCount: 15, medianMinutes: 20 },
    },
    allocation: { mode: 'none', slices: [] },
    usageRows: ROWS.filter((r) => r.activityId === 'act-api'),
  },
};

/** 前期間に記録が無い週。カードも一覧も差を作らない（比較する相手がいない）。 */
export const NoPreviousPeriod: Story = {
  args: {
    ...BASE_ARGS,
    summary: { current: BASE_ARGS.summary.current, previous: null },
    usageRows: ROWS.map((r) => ({ ...r, deltaMinutes: null })),
  },
};

/** 記録が 1 件も無い期間。責めない空文言を出す。 */
export const Empty: Story = {
  args: {
    ...BASE_ARGS,
    summary: {
      current: { recordedMinutes: 0, recordCount: 0, medianMinutes: null },
      previous: null,
    },
    marginMinutes: 10080,
    columns: WEEK_KEYS.map((key) => ({ key, stacks: [], totalMinutes: 0 })),
    allocation: { mode: 'none', slices: [] },
    hourTotals: Array.from({ length: 24 }, () => 0),
    durationBins: BINS.map((bin) => ({ ...bin, count: 0 })),
    usageRows: [],
  },
};

/** 月粒度。列は週になり、見出しも「週ごとの記録時間」へ変わる。縦軸の刻みが大きくなる。 */
export const MonthGranularity: Story = {
  args: {
    ...BASE_ARGS,
    granularity: 'month',
    columns: ['2026-09-01', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map(
      (key, index) => ({
        key,
        stacks: [{ key: 'c1', label: '開発', color: 'blue', minutes: 1900 - index * 260 }],
        totalMinutes: 1900 - index * 260,
      }),
    ),
  },
};

/** 年粒度。列は 12 か月。 */
export const YearGranularity: Story = {
  args: {
    ...BASE_ARGS,
    granularity: 'year',
    columns: Array.from({ length: 12 }, (_, index) => ({
      key: `2026-${String(index + 1).padStart(2, '0')}`,
      stacks: [{ key: 'c1', label: '開発', color: 'blue', minutes: 6000 + index * 300 }],
      totalMinutes: 6000 + index * 300,
    })),
  },
};

/** 最小幅（375px）。カードも 2 列のブロックも 1 列に積む。 */
export const Narrow: Story = {
  args: BASE_ARGS,
  decorators: [
    (Story) => (
      <div className="w-[375px]">
        <Story />
      </div>
    ),
  ],
};

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。 */
export const AllPatterns: Story = {
  args: BASE_ARGS,
  parameters: {
    a11y: {
      config: {
        // 同じ面を並べて見せる一覧なので、`aria-label` の同じ section が必ず重なる。
        // 実画面では 1 タブに 1 面しか描かないため、この重複は起きない
        rules: [{ id: 'landmark-unique', enabled: false }],
      },
    },
  },
  render: function AllPatternsAllocation() {
    return (
      <div className="flex flex-col gap-10">
        <Row label="通常（カテゴリー別）">
          <AllocationChapter {...BASE_ARGS} />
        </Row>
        <Row label="1 カテゴリーだけ（アクティビティ別）">
          <AllocationChapter {...(ActivityBreakdown.args as typeof BASE_ARGS)} />
        </Row>
        <Row label="アクティビティ 1 つだけ（配分を省く）">
          <AllocationChapter {...(SingleActivity.args as typeof BASE_ARGS)} />
        </Row>
        <Row label="前期間なし（差を出さない）">
          <AllocationChapter {...(NoPreviousPeriod.args as typeof BASE_ARGS)} />
        </Row>
        <Row label="空（記録なし）">
          <AllocationChapter {...(Empty.args as typeof BASE_ARGS)} />
        </Row>
      </div>
    );
  },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      {children}
    </div>
  );
}

function row(
  activityId: string | null,
  name: string | null,
  categoryName: string | null,
  color: string | null,
  recordedMinutes: number,
  recordBoxes: number,
  medianRecordMinutes: number | null,
  deltaMinutes: number | null,
): ReportActivityUsageRow {
  return {
    activityId,
    name,
    categoryName,
    color,
    archived: false,
    recordedMinutes,
    recordBoxes,
    medianRecordMinutes,
    deltaMinutes,
  };
}
