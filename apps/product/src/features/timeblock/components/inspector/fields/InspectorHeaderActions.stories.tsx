import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { getTimeblockMenuItems } from '@/features/timeblock/lib/timeblock-menu-items';

import { InspectorHeaderActions } from './InspectorHeaderActions';

/**
 * InspectorHeaderActions — Inspector パネル最上部の utility 行
 *
 * 「…」メニュー（getTimeblockMenuItems で生成された項目）+ 閉じるボタンを配置する。
 * アクティビティ選択（ActivityFieldRow）が時間フィールド直下へ移動した後も、
 * この行はパネル最上部に独立して常時表示する（#2298）。
 */
const meta = {
  title: 'Product/Features/Timeblock/Inspector/InspectorHeaderActions',
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

// ---------------------------------------------------------------------------
// Menu builders（実コードと同じ getTimeblockMenuItems を経由）
// ---------------------------------------------------------------------------

const fullPlannedMenu = getTimeblockMenuItems({
  activityId: 'activity-1',
  onViewStats: fn(),
  onCopy: fn(),
  onDuplicate: fn(),
  onDelete: fn(),
});

/** Record のメニュー。 */
const recordMenu = getTimeblockMenuItems({
  activityId: 'activity-1',
  onViewStats: fn(),
  onCopy: fn(),
  onDuplicate: fn(),
  onDelete: fn(),
});

const copyAndDeleteMenu = getTimeblockMenuItems({
  activityId: 'activity-1',
  onCopy: fn(),
  onDuplicate: fn(),
  onDelete: fn(),
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** フルメニュー + 閉じるボタン（planned）。 */
export const WithMenu: Story = {
  render: () => (
    <div className="w-72">
      <InspectorHeaderActions menuItems={fullPlannedMenu} onCloseInspector={fn()} />
    </div>
  ),
};

/** コピー・複製と削除（振り返りなし）。 */
export const CopyAndDelete: Story = {
  render: () => (
    <div className="w-72">
      <InspectorHeaderActions menuItems={copyAndDeleteMenu} onCloseInspector={fn()} />
    </div>
  ),
};

/** Record。 */
export const Record: Story = {
  render: () => (
    <div className="w-72">
      <InspectorHeaderActions menuItems={recordMenu} onCloseInspector={fn()} />
    </div>
  ),
};

/** メニューなし（閉じるボタンのみ）。 */
export const CloseOnly: Story = {
  render: () => (
    <div className="w-72">
      <InspectorHeaderActions onCloseInspector={fn()} />
    </div>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-6">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">フルメニュー（planned）</p>
        <InspectorHeaderActions menuItems={fullPlannedMenu} onCloseInspector={fn()} />
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Record</p>
        <InspectorHeaderActions menuItems={recordMenu} onCloseInspector={fn()} />
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">メニューなし（閉じるボタンのみ）</p>
        <InspectorHeaderActions onCloseInspector={fn()} />
      </div>
    </div>
  ),
};
