import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { Activity, Category } from '@/features/activities';
import { StoryTRPCProvider } from '@dayopt/storybook/mocks/trpc';

import { ActivityChipRow } from './ActivityChipRow';

const TIMESTAMPS = {
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** 色とアイコンはカテゴリーが持ち、所属アクティビティが継承する */
const MOCK_CATEGORIES: Category[] = [
  {
    id: 'cat-work',
    name: '仕事',
    user_id: 'user-1',
    color: 'blue',
    icon: 'briefcase',
    archived_at: null,
    ...TIMESTAMPS,
  },
];

const MOCK_ACTIVITIES: Activity[] = [
  {
    id: 'act-meeting',
    name: '会議',
    user_id: 'user-1',
    category_id: 'cat-work',
    archived_at: null,
    ...TIMESTAMPS,
  },
  {
    id: 'act-workout',
    name: '運動',
    user_id: 'user-1',
    category_id: null,
    archived_at: null,
    ...TIMESTAMPS,
  },
];

/** 30 件までスケールさせた版（横スクロールの確認用） */
const MANY_ACTIVITIES: Activity[] = Array.from({ length: 30 }, (_, i) => ({
  id: `act-many-${i}`,
  name: `アクティビティ${i + 1}`,
  user_id: 'user-1',
  category_id: 'cat-work',
  archived_at: null,
  ...TIMESTAMPS,
}));

function mocks(activities: Activity[], categories: Category[] = MOCK_CATEGORIES) {
  return {
    'activities.listActivities': activities,
    'activities.listCategories': categories,
    'plans.list': [],
    'records.list': [],
  };
}

/**
 * モバイル専用のアクティビティチップ行。タイムライン下部の固定フッターに配置される想定。
 *
 * - 名前順で並ぶ（PC サイドバーと同じサーバー側の並び）
 * - アーカイブ済みは一覧の時点で除外される
 * - 色とアイコンは所属カテゴリーから継承し、未分類は中立表示
 * - タップで既定の長さのブロックを即作成し、詳細パネル（Drawer）で時刻を直す
 */
const meta = {
  title: 'Product/Features/Calendar/Sidebar/ActivityChipRow',
  component: ActivityChipRow,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
    a11y: { test: 'todo' },
  },
  decorators: [
    (Story) => (
      <div className="bg-background w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityChipRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: 7 タグ、ほぼ画面に収まる */
export const Default: Story = {
  parameters: {
    trpcMocks: mocks(MOCK_ACTIVITIES),
  },
};

/** ManyActivities: 30 件、横スクロールで全件アクセス可能 */
export const ManyActivities: Story = {
  parameters: {
    trpcMocks: mocks(MANY_ACTIVITIES),
  },
};

/** Empty: アクティビティゼロ → chip 行ごと非描画（null を返す） */
export const Empty: Story = {
  parameters: {
    trpcMocks: mocks([]),
  },
};

function FooterPreview({ activities }: { activities: Activity[] }) {
  return (
    <StoryTRPCProvider mocks={mocks(activities)}>
      <div className="border-border-subtle bg-background relative h-20 overflow-hidden rounded-lg border">
        <ActivityChipRow className="absolute" />
      </div>
    </StoryTRPCProvider>
  );
}

/** AllPatterns: fixed footer 化したモバイルのチップ行の主要状態を一覧表示 */
export const AllPatterns: Story = {
  render: () => (
    <div className="bg-background space-y-4 p-4">
      <FooterPreview activities={MOCK_ACTIVITIES} />
      <FooterPreview activities={MANY_ACTIVITIES} />
      <FooterPreview activities={[]} />
    </div>
  ),
};
