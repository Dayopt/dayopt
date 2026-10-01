import { useState, type ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import type { ActivityTree } from '@/features/activities';

import { PRESET_USER_SETTINGS } from '../../../../../../storybook/.storybook/mocks/presets';
import { TimeblockActivityCard } from './TimeblockActivityCard';
import { TimeblockInspectorHeader } from './TimeblockInspectorHeader';

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

  return (
    <div className="bg-surface-container w-full max-w-sm rounded-2xl pb-1">
      <TimeblockInspectorHeader kind={args.kind} />
      <TimeblockActivityCard {...args} {...selection} onActivityChange={handleActivityChange} />
    </div>
  );
}

const sharedArgs = {
  kind: 'plan',
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
    kind: { control: 'inline-radio', options: ['plan', 'record'] },
    categoryName: { control: 'text' },
  },
  render: (args) => <ActivityCardPreview {...args} />,
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeblockActivityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** アクティビティ選択カード。 */
export const Default: Story = {};

/** 予定はカテゴリー色の枠線で表示する。 */
export const Plan: Story = { args: { kind: 'plan' } };

/** 記録はカテゴリー色の淡い塗りで表示する。 */
export const Record: Story = { args: { kind: 'record' } };

/** 同じアクティビティの予定と記録を比較する。 */
export const PlanAndRecord: Story = {
  render: (args) => (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ActivityCardPreview {...args} kind="plan" />
      <ActivityCardPreview {...args} kind="record" />
    </div>
  ),
};

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
    <div className="space-y-4">
      {[{}, Uncategorized.args, NoActivity.args, Disabled.args, LongNames.args].map(
        (args, index) => (
          <div key={index} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ActivityCardPreview {...sharedArgs} {...args} kind="plan" />
            <ActivityCardPreview {...sharedArgs} {...args} kind="record" />
          </div>
        ),
      )}
    </div>
  ),
};
