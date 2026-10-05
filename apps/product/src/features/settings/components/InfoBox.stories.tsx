import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AlertTriangle, Crown } from 'lucide-react';

import { Button } from '@dayopt/components';

import { InfoBox } from './InfoBox';

const meta = {
  title: 'Product/Features/Settings/InfoBox',
  component: InfoBox,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[500px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InfoBox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** テキストのみの案内ボックス。 */
export const Default: Story = {
  args: {
    children: <p className="text-muted-foreground text-sm">Settings are saved automatically.</p>,
  },
};

/** アイコン + テキスト + ボタンのパターン。 */
export const WithIconAndAction: Story = {
  args: {
    children: (
      <div className="flex items-center gap-2">
        <Crown className="text-muted-foreground h-5 w-5 shrink-0" />
        <p className="text-foreground flex-1 text-sm">This feature requires a Pro plan.</p>
        <Button variant="outline" size="sm">
          Upgrade
        </Button>
      </div>
    ),
  },
};

/** destructiveバリアント（警告・エラー）。 */
export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-destructive h-4 w-4" />
          <span className="text-destructive dark:text-foreground text-sm font-medium">
            No recovery codes left
          </span>
        </div>
        <p className="text-destructive dark:text-foreground text-xs">
          Generate new recovery codes to avoid being locked out.
        </p>
      </div>
    ),
  },
};

/** 全パターン一覧。 */
export const AllPatterns: StoryObj = {
  render: () => (
    <div className="space-y-4">
      <InfoBox>
        <p className="text-muted-foreground text-sm">Settings are saved automatically.</p>
      </InfoBox>
      <InfoBox>
        <div className="flex items-center gap-2">
          <Crown className="text-muted-foreground h-5 w-5 shrink-0" />
          <p className="text-foreground flex-1 text-sm">This feature requires a Pro plan.</p>
          <Button variant="outline" size="sm">
            Upgrade
          </Button>
        </div>
      </InfoBox>
      <InfoBox variant="destructive">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-destructive h-4 w-4" />
          <span className="text-destructive dark:text-foreground text-sm font-medium">
            Warning message
          </span>
        </div>
      </InfoBox>
    </div>
  ),
};
