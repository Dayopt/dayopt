import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ReportHeader } from './ReportHeader';

/**
 * `/report` のヘッダー。
 *
 * カレンダーと同じ器（`AppHeader`）と同じ部品（`DateRangeDisplay` / `DateNavigator`）で
 * 組み、粒度切替だけがレポート固有。並ぶ順序と余白もカレンダーの中央グループに
 * 揃えてある（期間ラベル → `‹ 今日 ›` → 粒度、を左に固める）。
 */
const meta = {
  title: 'Product/Features/Review/Layout/ReportHeader',
  component: ReportHeader,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    granularity: { control: 'radio', options: ['week', 'month', 'year'] },
    weekStartsOn: { control: 'radio', options: [0, 1, 6] },
  },
} satisfies Meta<typeof ReportHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

const BASE_ARGS = {
  periodStart: new Date(2026, 7, 31),
  periodEnd: new Date(2026, 8, 6),
  granularity: 'week' as const,
  weekStartsOn: 1 as const,
  onNavigate: () => {},
  onGranularityChange: () => {},
};

export const Week: Story = { args: BASE_ARGS };

export const Narrow: Story = {
  args: BASE_ARGS,
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
};

export const Month: Story = {
  args: {
    ...BASE_ARGS,
    granularity: 'month',
    periodStart: new Date(2026, 8, 1),
    periodEnd: new Date(2026, 8, 30),
  },
};

export const Year: Story = {
  args: {
    ...BASE_ARGS,
    granularity: 'year',
    periodStart: new Date(2026, 0, 1),
    periodEnd: new Date(2026, 11, 31),
  },
};

/** 年をまたぐ週。期間ラベルに年が付く。 */
export const AcrossYears: Story = {
  args: {
    ...BASE_ARGS,
    periodStart: new Date(2026, 11, 28),
    periodEnd: new Date(2027, 0, 3),
  },
};

/** 日曜始まりの設定。列と期間ラベルの起点が変わる。 */
export const SundayStart: Story = {
  args: {
    ...BASE_ARGS,
    weekStartsOn: 0,
    periodStart: new Date(2026, 7, 30),
    periodEnd: new Date(2026, 8, 5),
  },
};

/**
 * Composition Layer が両端の slot を差した状態。
 *
 * 粒度は左のまとまり（期間ラベル・`‹ 今日 ›` と同じ列）に、注入された action は
 * 右端に出る。位置を戻した時にここで気づけるようにしておく。
 */
export const WithSlots: Story = {
  args: {
    ...BASE_ARGS,
    leftSlot: <SlotButton label="サイドバー" />,
    rightSlot: <SlotButton label="カレンダーへ" />,
  },
};

/** すべての粒度を並べる（ADR-023 の AllPatterns）。 */
export const AllPatterns: Story = {
  args: BASE_ARGS,
  render: function AllPatternsReportHeader() {
    return (
      <div className="flex flex-col gap-4">
        <ReportHeader {...BASE_ARGS} />
        <ReportHeader
          {...BASE_ARGS}
          leftSlot={<SlotButton label="サイドバー" />}
          rightSlot={<SlotButton label="カレンダーへ" />}
        />
        <ReportHeader
          {...BASE_ARGS}
          granularity="month"
          periodStart={new Date(2026, 8, 1)}
          periodEnd={new Date(2026, 8, 30)}
        />
        <ReportHeader
          {...BASE_ARGS}
          granularity="year"
          periodStart={new Date(2026, 0, 1)}
          periodEnd={new Date(2026, 11, 31)}
        />
      </div>
    );
  },
};

/** slot に差さる想定のボタン（Composition Layer が渡すものの代役）。 */
function SlotButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="border-border-subtle text-muted-foreground h-8 rounded-lg border px-2 text-xs"
    >
      {label}
    </button>
  );
}
