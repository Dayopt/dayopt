import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import {
  TimeblockRelationshipSection,
  type TimeblockRelationshipItem,
} from './TimeblockRelationshipSection';

const relatedRecords: TimeblockRelationshipItem[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    activityName: 'API開発',
    activityColor: 'blue',
    activityIcon: 'code-2',
    isUncategorized: false,
    startAt: new Date('2026-07-14T09:05:00'),
    endAt: new Date('2026-07-14T09:35:00'),
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    activityName: 'レビュー',
    activityColor: 'green',
    activityIcon: 'search',
    isUncategorized: false,
    startAt: new Date('2026-07-14T10:10:00'),
    endAt: new Date('2026-07-14T10:55:00'),
  },
];

/** タグ削除で未分類化した(#1576) Record。アイコンは中立マーカー(bg-muted + Minus)。 */
const uncategorizedRecord: TimeblockRelationshipItem = {
  id: '00000000-0000-4000-8000-000000000103',
  activityName: 'タグなし',
  activityColor: null,
  activityIcon: null,
  isUncategorized: true,
  startAt: new Date('2026-07-14T11:00:00'),
  endAt: new Date('2026-07-14T11:20:00'),
};

const meta = {
  title: 'Product/Features/Timeblock/TimeblockRelationshipSection',
  component: TimeblockRelationshipSection,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof TimeblockRelationshipSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1件のRecordが時間帯に重なるPlan。 */
export const PlanSingle: Story = {
  args: {
    kind: 'plan',
    status: 'success',
    records: relatedRecords.slice(0, 1),
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 複数のRecordが時間帯に重なるPlan。件数と合計記録時間を表示する。 */
export const PlanMultiple: Story = {
  args: {
    kind: 'plan',
    status: 'success',
    records: relatedRecords,
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** タグ削除で未分類化したRecordが混じるPlan。当該行だけ中立マーカーを表示する。 */
export const PlanWithUncategorizedRecord: Story = {
  args: {
    kind: 'plan',
    status: 'success',
    records: [...relatedRecords, uncategorizedRecord],
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 日をまたぐ記録。開始日と終了日の双方を表示する。 */
export const CrossDay: Story = {
  args: {
    kind: 'plan',
    status: 'success',
    records: [
      {
        ...relatedRecords[0]!,
        id: '00000000-0000-4000-8000-000000000002',
        startAt: new Date('2026-07-14T23:30:00'),
        endAt: new Date('2026-07-15T01:00:00'),
      },
    ],
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 狭いモバイル幅で長いタグ名を省略する。 */
export const MobileNarrow: Story = {
  render: () => (
    <div className="w-full max-w-xs">
      <TimeblockRelationshipSection
        kind="plan"
        status="success"
        records={[
          {
            ...relatedRecords[0]!,
            activityName: '設計レビューとAPIインターフェースの整理',
          },
        ]}
        onOpen={fn()}
        onRetry={fn()}
      />
    </div>
  ),
  args: {
    kind: 'plan',
    status: 'success',
    records: [relatedRecords[0]!],
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 関係データの読み込み中。 */
export const Loading: Story = {
  args: {
    kind: 'plan',
    status: 'loading',
    records: [],
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 関係データだけ取得に失敗した状態。 */
export const Error: Story = {
  args: {
    kind: 'plan',
    status: 'error',
    records: [],
    onOpen: fn(),
    onRetry: fn(),
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  args: {
    kind: 'plan',
    status: 'success',
    records: relatedRecords,
    onOpen: fn(),
    onRetry: fn(),
  },
  render: () => (
    <div className="flex w-full max-w-md flex-col gap-6">
      <TimeblockRelationshipSection
        kind="plan"
        status="success"
        records={relatedRecords.slice(0, 1)}
        onOpen={fn()}
        onRetry={fn()}
      />
      <TimeblockRelationshipSection
        kind="plan"
        status="success"
        records={relatedRecords}
        onOpen={fn()}
        onRetry={fn()}
      />
      <TimeblockRelationshipSection
        kind="plan"
        status="success"
        records={[...relatedRecords, uncategorizedRecord]}
        onOpen={fn()}
        onRetry={fn()}
      />
      <TimeblockRelationshipSection
        kind="plan"
        status="loading"
        records={[]}
        onOpen={fn()}
        onRetry={fn()}
      />
      <TimeblockRelationshipSection
        kind="plan"
        status="error"
        records={[]}
        onOpen={fn()}
        onRetry={fn()}
      />
    </div>
  ),
};
