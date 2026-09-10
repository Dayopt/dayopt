/**
 * InlineCreatePanel Stories
 *
 * カレンダーをドラッグして時間帯を確定した時に、編集と同じ右パネル（モバイルは Drawer）へ
 * 出る作成モードの中身。上から種別タブ → 日付・時間 → アクティビティ一覧の順で、
 * アクティビティを押した瞬間に作成する。
 *
 * useInlineCreateStore に pendingSelection を置いて表示状態を再現する。
 */

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import type { ActivityTree } from '@/features/activities';

import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

import { InlineCreatePanel } from './InlineCreatePanel';

const TIMESTAMPS = {
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
};

const USER_ID = 'storybook-user';

const ACTIVITY_TREE = {
  categories: [
    {
      category: {
        id: 'work',
        user_id: USER_ID,
        name: '仕事',
        color: 'blue',
        icon: 'briefcase',
        archived_at: null,
        ...TIMESTAMPS,
      },
      activities: [
        {
          id: 'development',
          user_id: USER_ID,
          name: '開発',
          category_id: 'work',
          archived_at: null,
          ...TIMESTAMPS,
        },
        {
          id: 'meeting',
          user_id: USER_ID,
          name: '会議',
          category_id: 'work',
          archived_at: null,
          ...TIMESTAMPS,
        },
      ],
    },
    {
      category: {
        id: 'life',
        user_id: USER_ID,
        name: '生活',
        color: 'green',
        icon: 'heart',
        archived_at: null,
        ...TIMESTAMPS,
      },
      activities: [
        {
          id: 'meal',
          user_id: USER_ID,
          name: '食事',
          category_id: 'life',
          archived_at: null,
          ...TIMESTAMPS,
        },
      ],
    },
  ],
  uncategorized: [
    {
      id: 'workout',
      user_id: USER_ID,
      name: '運動',
      category_id: null,
      archived_at: null,
      ...TIMESTAMPS,
    },
  ],
} satisfies ActivityTree;

const trpcMocks = {
  'activities.listTree': ACTIVITY_TREE,
  'plans.list': [],
  'records.list': [],
  // 一覧に添える「普段の長さ」。中央値のあるアクティビティにだけ出る
  'statistics.getActivityStats': {
    counts: {},
    planCounts: {},
    lastUsed: {},
    medianMinutes: { development: 90, meeting: 30 },
  },
};

/** 対象日の 9:00–10:00 を選択済みにする */
function seedSelection(dayOffset: number, kind?: 'plan' | 'record') {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(0, 0, 0, 0);
  useInlineCreateStore.setState({
    pendingSelection: {
      date,
      startHour: 9,
      startMinute: 0,
      endHour: 10,
      endMinute: 0,
      ...(kind ? { kind } : {}),
    },
  });
}

const meta = {
  title: 'Product/Features/Calendar/Create/InlineCreatePanel',
  component: InlineCreatePanel,
  parameters: {
    layout: 'centered',
    trpcMocks,
  },
  tags: ['autodocs'],
  args: {
    onClose: fn(),
  },
  decorators: [
    // 実際の器（PC は DockedInspectorPanel、モバイルは Drawer 本文）と同じく、
    // 縦スクロールは外側が持つ。パネル自身はスクロールしない
    (Story) => (
      <div className="border-border bg-background flex h-[560px] w-100 flex-col overflow-hidden rounded-lg border">
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof InlineCreatePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 未来スロット。既定は予定で、記録タブは選べず理由が出る。 */
export const FutureSlot: Story = {
  render: (args) => {
    seedSelection(2);
    return <InlineCreatePanel {...args} />;
  },
};

/** 過去スロット。既定は記録で、予定へも切り替えられる。 */
export const PastSlot: Story = {
  render: (args) => {
    seedSelection(-2);
    return <InlineCreatePanel {...args} />;
  },
};

/** 過去スロットで予定タブへ切り替えた状態。 */
export const PastSlotAsPlan: Story = {
  render: (args) => {
    seedSelection(-2, 'plan');
    return <InlineCreatePanel {...args} />;
  },
};

/** モバイル: Drawer の中身として同じ内容が出る。 */
export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
    layout: 'fullscreen',
    trpcMocks,
  },
  decorators: [
    (Story) => (
      <div className="bg-background flex h-[640px] w-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => {
    seedSelection(-2);
    return <InlineCreatePanel {...args} />;
  },
};

/** 全パターンの基準となるインタラクティブ表示。 */
export const AllPatterns: Story = {
  render: (args) => {
    seedSelection(-2);
    return <InlineCreatePanel {...args} />;
  },
};
