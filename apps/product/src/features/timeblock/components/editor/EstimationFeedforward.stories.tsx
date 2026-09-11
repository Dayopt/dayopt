import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { EstimationFeedforward } from './EstimationFeedforward';

/** 直近 4 週の中央値が 1.5 倍の activity（n=4）。 */
const FACTORS = [
  { activityId: 'activity-work', factor: 1.5, sampleCount: 4 },
  { activityId: 'activity-learning', factor: 0.75, sampleCount: 6 },
];

const withFactors = { trpcMocks: { 'statistics.getTagEstimationFactors': FACTORS } };

const meta = {
  title: 'Product/Features/Timeblock/EstimationFeedforward',
  component: EstimationFeedforward,
  tags: ['autodocs'],
  // Inspector の実幅（PC の docked panel）に近い器で見る。バッジは日時グルーピングの
  // 直上に置くので、パネル幅で文が折り返すかどうかがそのまま見え方になる
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', ...withFactors },
  args: {
    destination: 'plan',
    activityId: 'activity-work',
    draftMinutes: 30,
  },
} satisfies Meta<typeof EstimationFeedforward>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 見積もりより長くかかる傾向の activity（1.5 倍 × 30 分 = 45 分）。 */
export const LongerThanPlanned: Story = {};

/** 見積もりより短く終わる傾向の activity（0.75 倍 × 60 分 = 45 分）。 */
export const ShorterThanPlanned: Story = {
  args: { activityId: 'activity-learning', draftMinutes: 60 },
};

/** 保存先が Record のときは出さない（過去の事実に見積もりの話は要らない）。 */
export const RecordDestination: Story = {
  args: { destination: 'record' },
};

/** activity 未選択では出さない。 */
export const NoTag: Story = {
  args: { activityId: null },
};

/** サンプルが 3 件未満の activity は server が返さないので出ない。 */
export const InsufficientSamples: Story = {
  args: { activityId: 'activity-life' },
};

/** 取得に失敗しても ErrorState を出さず、静かに消える。 */
export const QueryFailed: Story = {
  parameters: { trpcMocks: { 'statistics.getTagEstimationFactors': undefined } },
};

/** 全パターン一覧。何も出ないケースは高さ 0 になる。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-4">
      <EstimationFeedforward destination="plan" activityId="activity-work" draftMinutes={30} />
      <EstimationFeedforward destination="plan" activityId="activity-learning" draftMinutes={60} />
      <EstimationFeedforward destination="plan" activityId="activity-work" draftMinutes={120} />
      <EstimationFeedforward destination="record" activityId="activity-work" draftMinutes={30} />
      <EstimationFeedforward destination="plan" activityId={null} draftMinutes={30} />
      <EstimationFeedforward destination="plan" activityId="activity-life" draftMinutes={30} />
    </div>
  ),
};
