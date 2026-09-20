import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ReportFilterList } from './ReportFilterList';

/**
 * `/report` サイドバーの分析フィルタ（分母から出し入れする一覧）。
 *
 * 骨格・余白・ホバーはカレンダーの `ActivityFilterList` と同じ（「カテゴリ」「未分類」の 2 見出し、
 * 右端の 👁 は見えている行ならホバーで出る）。
 * `activities.listTree` を tRPC でモックし、トグル状態は `useReportViewStore` で作る。
 */
const meta = {
  title: 'Product/Features/Review/Sidebar/ReportFilterList',
  component: ReportFilterList,
  parameters: {
    layout: 'padded',
    trpcMocks: { 'activities.listTree': MOCK_TREE() },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-60">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReportFilterList>;

export default meta;
type Story = StoryObj<typeof meta>;

const ALL_VISIBLE = {
  hiddenCategoryIds: [],
  hiddenActivityIds: [],
};

/** 既定。すべてのカテゴリーと未分類・余白が分母に入っている。 */
export const Default: Story = {
  parameters: { storeMocks: { useReportViewStore: ALL_VISIBLE } },
};

/** 睡眠を分母から外した状態。見出しと配下が muted になる（余白の値は動かない）。 */
export const CategoryHidden: Story = {
  parameters: {
    storeMocks: { useReportViewStore: { ...ALL_VISIBLE, hiddenCategoryIds: ['cat-sleep'] } },
  },
};

/** アクティビティを 1 つだけ外した状態。カテゴリーの 👁 は「一部」として常時出る。 */
export const ActivityHidden: Story = {
  parameters: {
    storeMocks: { useReportViewStore: { ...ALL_VISIBLE, hiddenActivityIds: ['act-review'] } },
  },
};

/** カテゴリーも未分類も無い状態。2 つの見出しに空の文言が出る。 */
export const NoCategories: Story = {
  parameters: {
    trpcMocks: { 'activities.listTree': { categories: [], uncategorized: [] } },
    storeMocks: { useReportViewStore: ALL_VISIBLE },
  },
};

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。見えている / 一部 / 外したが同居する。 */
export const AllPatterns: Story = {
  parameters: {
    storeMocks: {
      useReportViewStore: {
        ...ALL_VISIBLE,
        hiddenCategoryIds: ['cat-sleep'],
        hiddenActivityIds: ['act-review'],
      },
    },
  },
  render: function AllPatternsReportFilterList() {
    return (
      <div className="w-60">
        <ReportFilterList />
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
      {
        category: category('cat-study', '学習', 'green', 'book-open'),
        activities: [activity('act-reading', '読書', 'cat-study')],
      },
    ],
    uncategorized: [activity('act-walk', '散歩', null)],
  };
}
