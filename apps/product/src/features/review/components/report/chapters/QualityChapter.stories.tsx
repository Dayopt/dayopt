import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { QualityChapter } from './QualityChapter';

import type { ReportCompassPoint } from '../../../domain/report/report-view-model';

/**
 * 3 章「質 — それは良い配分だったか」。
 *
 * 点は充実の回答が 5 件以上のアクティビティだけ。足りない行は名前だけ待機リストへ回る。
 */
const meta = {
  title: 'Product/Features/Review/Chapters/Quality',
  component: QualityChapter,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof QualityChapter>;

export default meta;
type Story = StoryObj<typeof meta>;

const POINTS: ReportCompassPoint[] = [
  {
    activityId: 'act-write',
    categoryName: '仕事',
    name: '執筆',
    color: 'blue',
    x: 92,
    y: 78,
    opacity: 1,
    answerCount: 9,
    recordedMinutes: 600,
  },
  {
    activityId: 'act-mail',
    categoryName: '仕事',
    name: 'メール',
    color: 'violet',
    x: 34,
    y: 22,
    opacity: 0.74,
    answerCount: 6,
    recordedMinutes: 220,
  },
  {
    activityId: 'act-read',
    categoryName: '学習',
    name: '読書',
    color: 'green',
    x: 18,
    y: 66,
    opacity: 0.61,
    answerCount: 5,
    recordedMinutes: 120,
  },
];

export const Default: Story = {
  args: {
    points: POINTS,
    waitingActivities: [
      { activityId: 'act-gym', name: '運動' },
      { activityId: 'act-chore', name: '家事' },
    ],
  },
};

/** 充実に 1 件も回答がない週。盤は空文言だけで、エラーにはならない（仕様 §13-6）。 */
export const NoPoints: Story = {
  args: {
    points: [],
    waitingActivities: [
      { activityId: 'act-gym', name: '運動' },
      { activityId: 'act-write', name: '執筆' },
      { activityId: null, name: null },
    ],
  },
};

/** 待機がいない週。footnote だけが残る。 */
export const NoWaiting: Story = { args: { points: POINTS, waitingActivities: [] } };

/** 記録も回答もまだ無い週。 */
export const Empty: Story = { args: { points: [], waitingActivities: [] } };

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。 */
// 展示専用。各状態はこのファイルの独立 Story で全件検証する。
export const AllPatterns: Story = {
  tags: ['docs-only'],
  args: { points: POINTS, waitingActivities: [] },
  render: function AllPatternsQuality() {
    const waiting = [
      { activityId: 'act-gym', name: '運動' },
      { activityId: 'act-chore', name: '家事' },
    ];
    return (
      <div className="flex flex-col gap-6">
        <Row label="通常（点 + 待機）">
          <QualityChapter points={POINTS} waitingActivities={waiting} />
        </Row>
        <Row label="回答が閾値未満で点が無い（盤は黙る）">
          <QualityChapter points={[]} waitingActivities={waiting} />
        </Row>
        <Row label="待機がいない（footnote だけ）">
          <QualityChapter points={POINTS} waitingActivities={[]} />
        </Row>
        <Row label="記録も回答も無い">
          <QualityChapter points={[]} waitingActivities={[]} />
        </Row>
        <Row label="狭い面（320px）">
          <div className="w-[320px]">
            <QualityChapter points={POINTS} waitingActivities={waiting} />
          </div>
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

/** 狭い面でも内容が読める。 */
export const Mobile: Story = {
  ...Default,
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
};
