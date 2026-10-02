import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { BoundaryRecovery } from './BoundaryRecovery';
import { GlobalErrorPresentation } from './GlobalErrorPresentation';
import { RootErrorState } from './RootErrorState';

const exampleError = new Error('Example render failure');

const meta = {
  title: 'Web/Components/Feedback/RootErrorState',
  component: RootErrorState,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    error: exampleError,
    onRetry: () => undefined,
  },
} satisfies Meta<typeof RootErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Production presentation without diagnostic details. */
export const Production: Story = {};

/** Local development presentation with the original stack. */
export const Development: Story = {
  args: { showDetails: true },
};

/** Recovery controls while the detailed view is loading or unavailable. */
export const LoadingRecovery: Story = {
  args: { onRetry: fn() },
  render: (args) => <BoundaryRecovery {...args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
    await expect(canvas.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  },
};

/** Global presentation keeps the current error boundary's retry callback. */
export const Global: Story = {
  args: { onRetry: fn() },
  render: (args) => <GlobalErrorPresentation {...args} />,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** All supported error presentation states. */
export const AllPatterns: Story = {
  parameters: {
    a11y: {
      options: {
        // RootErrorState は Next.js の error boundary fallback として1ページ丸ごとを
        // 描画する設計（ErrorLayout に header/main/footer を含む）。カタログ表示のため
        // 2インスタンスを並べており、実際のページでは landmark は重複しない
        rules: {
          'landmark-no-duplicate-banner': { enabled: false },
          'landmark-no-duplicate-contentinfo': { enabled: false },
          'landmark-no-duplicate-main': { enabled: false },
          'landmark-unique': { enabled: false },
        },
      },
    },
  },
  render: (args) => (
    <div className="flex flex-col">
      <RootErrorState {...args} showDetails={false} />
      <RootErrorState {...args} showDetails />
      <BoundaryRecovery {...args} />
      <GlobalErrorPresentation {...args} />
    </div>
  ),
};
