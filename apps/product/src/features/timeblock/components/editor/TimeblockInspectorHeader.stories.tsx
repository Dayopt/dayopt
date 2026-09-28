import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Copy } from 'lucide-react';
import { fn } from 'storybook/test';

import type { TimeblockMenuItem } from '../../lib/timeblock-menu-items';
import { TimeblockInspectorHeader } from './TimeblockInspectorHeader';

const menuItems = [
  {
    key: 'copy',
    labelKey: 'common.actions.copy',
    icon: Copy,
    dangerous: false,
    onSelect: fn(),
  },
] satisfies TimeblockMenuItem[];

const sharedArgs = {
  menuItems,
  onCloseInspector: fn(),
  disabled: false,
};

const meta = {
  title: 'Product/Features/Timeblock/Inspector/Header',
  component: TimeblockInspectorHeader,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeblockInspectorHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 予定の種別ラベルと操作ボタン。 */
export const Plan: Story = {
  args: { ...sharedArgs, kind: 'plan' },
};

/** 記録の種別ラベルと操作ボタン。 */
export const Record: Story = {
  args: { ...sharedArgs, kind: 'record' },
};
