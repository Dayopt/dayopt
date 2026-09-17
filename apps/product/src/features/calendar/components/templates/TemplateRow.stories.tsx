import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { TemplateRow } from './TemplateRow';
import type { TemplateView } from './types';

/**
 * サイドバーのテンプレート行（v1.0 §5.4）。ホバーでミニプレビュー、
 * クリックで適用、右クリックで改名・削除に畳んだ統治メニュー。
 */
const meta = {
  title: 'Product/Features/Calendar/Templates/TemplateRow',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div role="list" className="w-56">
      {children}
    </div>
  );
}

function makeTemplate(overrides: Partial<TemplateView> = {}): TemplateView {
  return {
    id: 'template-1',
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
    ...overrides,
  };
}

/** 通常状態。ホバーでミニプレビューが右に開く。 */
export const Idle: Story = {
  render: () => (
    <Frame>
      <TemplateRow template={makeTemplate()} />
    </Frame>
  ),
};

/** クリック適用直後の静的表現。 */
export const Applying: Story = {
  render: () => (
    <Frame>
      <TemplateRow template={makeTemplate()} visualState="applying" />
    </Frame>
  ),
};

/** 任意の日へドラッグ中の静的表現（ソース側は控えめに沈める）。 */
export const Dragging: Story = {
  render: () => (
    <Frame>
      <TemplateRow template={makeTemplate()} visualState="dragging" />
    </Frame>
  ),
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">通常（ホバーでプレビュー）</p>
        <Frame>
          <TemplateRow template={makeTemplate()} />
        </Frame>
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">クリック適用中</p>
        <Frame>
          <TemplateRow template={makeTemplate()} visualState="applying" />
        </Frame>
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">ドラッグ中（ソース側）</p>
        <Frame>
          <TemplateRow template={makeTemplate()} visualState="dragging" />
        </Frame>
      </div>
    </div>
  ),
};
