import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ReportMobileHeader } from './ReportMobileHeader';

/**
 * `/report` のヘッダー（モバイル）。
 *
 * カレンダーのモバイルヘッダーと同じ作り: 期間ラベルを押すと月グリッドがインライン
 * 展開する。デスクトップ（`ReportHeader`）との違いは 2 つで、**粒度切替を出さない**
 * （仕様 §8。粒度そのものは URL に従うので、月・年のリンクをスマホで開いてもその期間の
 * まま描く）ことと、**期間ラベルが年を持たない**（年粒度を除く）こと。
 */
const meta = {
  title: 'Product/Features/Review/Layout/ReportMobileHeader',
  component: ReportMobileHeader,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
  },
  argTypes: {
    granularity: { control: 'radio', options: ['week', 'month', 'year'] },
    todayDirection: { control: 'radio', options: ['past', 'current', 'future'] },
  },
} satisfies Meta<typeof ReportMobileHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

const BASE_ARGS = {
  periodStart: new Date(2026, 7, 31),
  periodEnd: new Date(2026, 8, 6),
  granularity: 'week' as const,
  todayDirection: 'current' as const,
  onNavigate: () => {},
  onDateSelect: () => {},
};

/** 既定（375x812）。ラベルは「8月31日〜9月6日」で、年を出さない。 */
export const Week: Story = { args: BASE_ARGS };

/** ミニカレンダーを開いた状態。粒度の行が上に出て、選択中の期間が帯で塗られる。 */
export const MiniCalendarExpanded: Story = {
  args: { ...BASE_ARGS, defaultExpanded: true, onGranularityChange: () => {} },
};

/**
 * 過去の期間を見ている。右端に「今日へ」が出る（`‹ ›` は置かず、期間の移動は
 * 本文の左右スワイプが担う）。今日を含む期間ではこのボタン自体を出さない。
 */
export const PastPeriod: Story = {
  args: { ...BASE_ARGS, todayDirection: 'past' },
};

/**
 * 日付選択を渡さない場合。ミニカレンダーごと出さず、ラベルはただのテキストになる
 * （押しても何も起きない chevron を残さない）。
 */
export const WithoutDateSelect: Story = {
  args: { ...BASE_ARGS, onDateSelect: undefined },
};

/** URL が月粒度のまま開かれた場合。週へ丸めない。 */
export const Month: Story = {
  args: {
    ...BASE_ARGS,
    granularity: 'month',
    periodStart: new Date(2026, 8, 1),
    periodEnd: new Date(2026, 8, 30),
  },
};

/** 最小幅（320px）。年をまたぐ週でも年を足さず、`‹ ›` が押せる幅を保つ。 */
export const NarrowScreen: Story = {
  args: {
    ...BASE_ARGS,
    periodStart: new Date(2026, 11, 28),
    periodEnd: new Date(2027, 0, 3),
  },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
};

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。 */
export const AllPatterns: Story = {
  parameters: {
    a11y: {
      config: {
        // 同じヘッダーを並べて見せる一覧なので、banner landmark が必ず重なる。
        // 実画面では 1 ページに 1 つしか描かないため、この重複は起きない
        rules: [
          { id: 'landmark-no-duplicate-banner', enabled: false },
          { id: 'landmark-unique', enabled: false },
        ],
      },
    },
  },
  args: BASE_ARGS,
  render: function AllPatternsMobileHeader() {
    return (
      <div className="flex flex-col gap-6">
        <Row label="週（年なし・粒度切替は出さない）">
          <ReportMobileHeader {...BASE_ARGS} />
        </Row>
        <Row label="月（URL の粒度を尊重）">
          <ReportMobileHeader
            {...BASE_ARGS}
            granularity="month"
            periodStart={new Date(2026, 8, 1)}
            periodEnd={new Date(2026, 8, 30)}
          />
        </Row>
        <Row label="年（ここだけ年を出す）">
          <ReportMobileHeader
            {...BASE_ARGS}
            granularity="year"
            periodStart={new Date(2026, 0, 1)}
            periodEnd={new Date(2026, 11, 31)}
          />
        </Row>
        <Row label="年をまたぐ週">
          <ReportMobileHeader
            {...BASE_ARGS}
            periodStart={new Date(2026, 11, 28)}
            periodEnd={new Date(2027, 0, 3)}
          />
        </Row>
        <Row label="最小幅（320px）">
          <div className="w-[320px]">
            <ReportMobileHeader {...BASE_ARGS} />
          </div>
        </Row>
        <Row label="過去の期間（今日へが出る）">
          <ReportMobileHeader {...BASE_ARGS} todayDirection="past" />
        </Row>
        <Row label="ミニカレンダー展開中（粒度は中に入る）">
          <ReportMobileHeader {...BASE_ARGS} defaultExpanded onGranularityChange={() => {}} />
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
