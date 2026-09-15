import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ReportFilterDrawer } from './ReportFilterDrawer';

/**
 * モバイルのフィルタ（仕様 §8）。タブ行の右端のボタンから、サイドバーと同じ一覧を Drawer で開く。
 * `activities.listTree` を tRPC でモックし、出し入れの状態は `useReportViewStore` で作る。
 */
const meta = {
  title: 'Product/Features/Review/Sidebar/ReportFilterDrawer',
  component: ReportFilterDrawer,
  parameters: {
    layout: 'padded',
    viewport: { defaultViewport: 'mobile1' },
    trpcMocks: { 'activities.listTree': MOCK_TREE() },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ReportFilterDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const ALL_VISIBLE = { hiddenCategoryIds: [], hiddenActivityIds: [] };

/** 既定。何も外していないので印は付かない。ボタンを押すと Drawer が開く。 */
export const Default: Story = {
  parameters: { storeMocks: { useReportViewStore: ALL_VISIBLE } },
};

/** 何かを外している状態。ボタンに点が付き、開くと外した行の 👁 が常時出ている。 */
export const Filtering: Story = {
  parameters: {
    storeMocks: {
      useReportViewStore: { hiddenCategoryIds: ['cat-sleep'], hiddenActivityIds: ['act-review'] },
    },
  },
};

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。 */
export const AllPatterns: Story = {
  parameters: {
    storeMocks: {
      useReportViewStore: { hiddenCategoryIds: ['cat-sleep'], hiddenActivityIds: ['act-review'] },
    },
  },
  render: function AllPatternsReportFilterDrawer() {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-xs">外している状態（点付き）</p>
        <ReportFilterDrawer />
      </div>
    );
  },
};

/** サーバーの `activities.listTree` と同じ形。 */
function MOCK_TREE() {
  const timestamps = {
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  const category = (id: string, name: string, color: string, icon: string) => ({
    id,
    name,
    user_id: 'user-1',
    color,
    icon,
    archived_at: null,
    ...timestamps,
  });
  const activity = (id: string, name: string, categoryId: string | null) => ({
    id,
    name,
    user_id: 'user-1',
    category_id: categoryId,
    archived_at: null,
    ...timestamps,
  });

  return {
    categories: [
      {
        category: category('cat-work', '仕事', 'blue', 'briefcase'),
        activities: [
          activity('act-dev', '実装', 'cat-work'),
          activity('act-review', 'レビュー', 'cat-work'),
        ],
      },
      {
        category: category('cat-sleep', '睡眠', 'indigo', 'moon'),
        activities: [activity('act-sleep', '就寝', 'cat-sleep')],
      },
    ],
    uncategorized: [activity('act-walk', '散歩', null)],
  };
}
