import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Logo } from '@dayopt/components';

const meta = {
  title: 'Shared/Components/Identity/Logo',
  component: Logo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    label: {
      control: 'text',
      description: 'ロゴのアクセシブル名（文字形状は確定済みのDayopt）',
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
      description: 'ロゴのサイズ',
    },
    variant: {
      control: 'select',
      options: ['lockup', 'mark', 'wordmark'],
      description: 'ロゴの表示形式',
    },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 基本的な lockup ロゴ。 */
export const Default: Story = {
  args: {
    label: 'Dayopt',
    size: 'md',
    variant: 'lockup',
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <Logo size="sm" />
        <Logo size="md" />
        <Logo size="lg" />
      </div>
      <div className="flex items-center gap-4">
        <Logo variant="mark" size="sm" />
        <Logo variant="mark" size="md" />
        <Logo variant="mark" size="lg" />
      </div>
      <div className="flex items-center gap-4">
        <Logo variant="wordmark" size="sm" />
        <Logo variant="wordmark" size="md" />
        <Logo variant="wordmark" size="lg" />
      </div>
      <div className="dark bg-background rounded-lg p-6">
        <Logo size="lg" />
      </div>
    </div>
  ),
};
