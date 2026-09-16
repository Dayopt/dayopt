import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { CompactDateNavigator, DateNavigator } from './DateNavigator';

const meta = {
  title: 'Product/Components/Navigation/DateNavigator',
  component: DateNavigator,
  tags: ['autodocs'],
} satisfies Meta<typeof DateNavigator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    onNavigate: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    // Click previous (aria-label is Japanese "前へ")
    const prevBtn = canvas.getByRole('button', { name: /前へ/ });
    await userEvent.click(prevBtn);
    await expect(args.onNavigate).toHaveBeenCalledWith('prev');

    // Click today
    const todayBtn = canvas.getByRole('button', { name: '今日' });
    await userEvent.click(todayBtn);
    await expect(args.onNavigate).toHaveBeenCalledWith('today');

    // Click next (aria-label is Japanese "次へ")
    const nextBtn = canvas.getByRole('button', { name: /次へ/ });
    await userEvent.click(nextBtn);
    await expect(args.onNavigate).toHaveBeenCalledWith('next');
  },
};

export const Compact: Story = {
  args: {
    onNavigate: fn(),
  },
  render: function CompactStory(args) {
    return <CompactDateNavigator onNavigate={args.onNavigate} />;
  },
};

export const AllPatterns: Story = {
  args: {
    onNavigate: fn(),
  },
  render: function AllPatternsStory(args) {
    return (
      <div className="flex flex-col items-start gap-6">
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">Default (arrows + today)</p>
          <DateNavigator onNavigate={args.onNavigate} />
        </div>
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">Compact (arrows only)</p>
          <CompactDateNavigator onNavigate={args.onNavigate} />
        </div>
      </div>
    );
  },
};
