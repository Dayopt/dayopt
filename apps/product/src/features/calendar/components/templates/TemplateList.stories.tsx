import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { TemplateList } from './TemplateList';
import type { TemplateView } from './types';

/**
 * サイドバーのテンプレート列（v1.0 §5.1）。カテゴリー分けを持たないフラットな一覧。
 */
const meta = {
  title: 'Product/Features/Calendar/Templates/TemplateList',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-56">{children}</div>;
}

const templates: TemplateView[] = [
  {
    id: 't1',
    name: '朝のルーティン',
    blocks: [
      {
        id: 'b1',
        activityName: '集中作業',
        categoryColor: 'blue',
        categoryIcon: 'briefcase',
        anchorRatio: 0.05,
        medianDurationRatio: 0.3,
      },
      {
        id: 'b2',
        activityName: 'ランニング',
        categoryColor: 'teal',
        categoryIcon: 'footprints',
        anchorRatio: 0.4,
        medianDurationRatio: 0.15,
      },
    ],
  },
  {
    id: 't2',
    name: '在宅勤務日',
    blocks: [
      {
        id: 'b3',
        activityName: 'MTG',
        categoryColor: 'indigo',
        categoryIcon: 'users',
        anchorRatio: 0.1,
        medianDurationRatio: 0.1,
      },
      {
        id: 'b4',
        activityName: '集中作業',
        categoryColor: 'blue',
        categoryIcon: 'briefcase',
        anchorRatio: 0.25,
        medianDurationRatio: 0.35,
      },
      {
        id: 'b5',
        activityName: '昼休み',
        categoryColor: 'green',
        categoryIcon: 'utensils',
        anchorRatio: 0.5,
        medianDurationRatio: 0.08,
      },
    ],
  },
  {
    id: 't3',
    name: '休日',
    blocks: [
      {
        id: 'b6',
        activityName: '読書',
        categoryColor: 'violet',
        categoryIcon: 'book-open',
        anchorRatio: 0.2,
        medianDurationRatio: 0.2,
      },
    ],
  },
];

/** 通常の一覧。 */
export const Default: Story = {
  render: () => (
    <Frame>
      <TemplateList templates={templates} />
    </Frame>
  ),
};

/** テンプレートが1件もない状態。 */
export const Empty: Story = {
  render: () => (
    <Frame>
      <TemplateList templates={[]} />
    </Frame>
  ),
};

export const Loading: Story = {
  render: () => (
    <Frame>
      <TemplateList templates={[]} isLoading />
    </Frame>
  ),
};

export const Error: Story = {
  render: () => (
    <Frame>
      <TemplateList templates={[]} isError onRetry={fn()} />
    </Frame>
  ),
};

export const AvailableActions: Story = {
  render: () => (
    <Frame>
      <TemplateList templates={[]} onCreateEntry={fn()} onOpenSettings={fn()} />
    </Frame>
  ),
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-6">
      <Frame>
        <TemplateList templates={[]} isLoading />
      </Frame>
      <Frame>
        <TemplateList templates={[]} isError onRetry={fn()} />
      </Frame>
      <div className="space-y-2">
        <Frame>
          <TemplateList templates={templates} />
        </Frame>
      </div>
      <div className="space-y-2">
        <Frame>
          <TemplateList templates={[]} />
        </Frame>
      </div>
      <Frame>
        <TemplateList templates={[]} onCreateEntry={fn()} onOpenSettings={fn()} />
      </Frame>
    </div>
  ),
};
