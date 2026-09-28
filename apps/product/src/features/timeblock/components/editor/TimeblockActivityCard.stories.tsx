import { useState, type ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import type { ActivityTree } from '@/features/activities';

import { PRESET_USER_SETTINGS } from '../../../../../../storybook/.storybook/mocks/presets';
import { TimeblockActivityCard } from './TimeblockActivityCard';

const timestamps = {
  created_at: '2026-09-28T00:00:00.000Z',
  updated_at: '2026-09-28T00:00:00.000Z',
};

const activityTree = {
  categories: [
    {
      category: {
        id: 'category-work',
        user_id: 'storybook-user',
        name: '仕事',
        color: 'blue',
        icon: 'briefcase',
        archived_at: null,
        ...timestamps,
      },
      activities: [
        {
          id: 'activity-development',
          user_id: 'storybook-user',
          name: '開発',
          category_id: 'category-work',
          archived_at: null,
          ...timestamps,
        },
        {
          id: 'activity-meeting',
          user_id: 'storybook-user',
          name: '会議',
          category_id: 'category-work',
          archived_at: null,
          ...timestamps,
        },
      ],
    },
  ],
  uncategorized: [
    {
      id: 'activity-walk',
      user_id: 'storybook-user',
      name: '散歩',
      category_id: null,
      archived_at: null,
      ...timestamps,
    },
  ],
} satisfies ActivityTree;

type CardProps = ComponentProps<typeof TimeblockActivityCard>;
type Selection = Pick<
  CardProps,
  | 'activityId'
  | 'activityName'
  | 'categoryName'
  | 'activityColor'
  | 'activityIcon'
  | 'uncategorized'
>;

function ActivityCardPreview(args: CardProps) {
  const [selection, setSelection] = useState<Selection | null>(null);

  const handleActivityChange = (activityId: string | null) => {
    for (const { category, activities } of activityTree.categories) {
      const activity = activities.find((candidate) => candidate.id === activityId);
      if (activity) {
        setSelection({
          activityId: activity.id,
          activityName: activity.name,
          categoryName: category.name,
          activityColor: category.color,
          activityIcon: category.icon,
          uncategorized: false,
        });
        args.onActivityChange(activityId);
        return;
      }
    }

    const activity = activityTree.uncategorized.find((candidate) => candidate.id === activityId);
    if (activity) {
      setSelection({
        activityId: activity.id,
        activityName: activity.name,
        categoryName: null,
        activityColor: null,
        activityIcon: null,
        uncategorized: true,
      });
    }
    args.onActivityChange(activityId);
  };

  return <TimeblockActivityCard {...args} {...selection} onActivityChange={handleActivityChange} />;
}

const sharedArgs = {
  activityId: 'activity-development',
  activityName: '開発',
  categoryName: '仕事',
  activityColor: 'blue',
  activityIcon: 'briefcase',
  onActivityChange: fn(),
  onCreateAndSelect: fn(),
  disabled: false,
  durationByActivityId: new Map([
    ['activity-development', 45],
    ['activity-meeting', 30],
  ]),
} satisfies CardProps;

const meta = {
  title: 'Product/Features/Timeblock/Inspector/ActivityCard',
  component: TimeblockActivityCard,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    trpcMocks: {
      'activities.listTree': activityTree,
      'userSettings.get': PRESET_USER_SETTINGS.default,
    },
  },
  args: sharedArgs,
  argTypes: {
    categoryName: { control: 'text' },
  },
  render: (args) => <ActivityCardPreview {...args} />,
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeblockActivityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** アクティビティ選択カード。 */
export const Default: Story = {};

/** カテゴリーに所属していないアクティビティ。 */
export const Uncategorized: Story = {
  args: {
    activityId: 'activity-walk',
    activityName: '散歩',
    categoryName: null,
    activityColor: null,
    activityIcon: null,
    uncategorized: true,
  },
};

/** アクティビティが未設定の状態。 */
export const NoActivity: Story = {
  args: {
    activityId: null,
    activityName: 'アクティビティなし',
    categoryName: null,
    activityColor: null,
    activityIcon: null,
  },
};

/** 選択操作が無効の状態。 */
export const Disabled: Story = {
  args: { disabled: true },
};

/** 長い名前でもカード内で省略表示する。 */
export const LongNames: Story = {
  args: {
    activityName: 'プロジェクトのリサーチと開発方針の整理',
    categoryName: 'プロダクト開発・デザイン',
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="space-y-3">
      <TimeblockActivityCard {...sharedArgs} />
      <TimeblockActivityCard {...sharedArgs} {...Uncategorized.args} />
      <TimeblockActivityCard {...sharedArgs} {...NoActivity.args} />
      <TimeblockActivityCard {...sharedArgs} disabled />
      <TimeblockActivityCard {...sharedArgs} {...LongNames.args} />
    </div>
  ),
};
