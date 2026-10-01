import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';
import { GuideNavigation } from './GuideNavigation';

const meta = {
  title: 'Web/Content/GuideNavigation',
  component: GuideNavigation,
  parameters: { layout: 'padded' },
  args: {
    label: 'ガイドを選ぶ',
    navigation: [
      {
        title: '一日を計画する',
        items: [
          { title: '予定を立てる', href: '/docs/plans' },
          { title: 'カレンダーを操作する', href: '/docs/calendar' },
        ],
      },
      {
        title: 'よくある質問',
        items: [
          {
            title: 'よくある質問',
            href: '/docs/faq',
            items: [{ title: '機能', href: '/docs/faq/features' }],
          },
        ],
      },
    ],
  },
} satisfies Meta<typeof GuideNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;
/** 折りたたみ状態。 */
export const AllPatterns: Story = {};
/** 開く操作で初めて表示されるガイドを確かめる。 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const guide = canvas.getByRole('link', { name: '予定を立てる' });
    await expect(guide).not.toBeVisible();
    await userEvent.click(canvas.getByText('ガイドを選ぶ'));
    await expect(guide).toBeVisible();
    await expect(canvas.getByRole('link', { name: '機能' })).toBeVisible();
  },
};
