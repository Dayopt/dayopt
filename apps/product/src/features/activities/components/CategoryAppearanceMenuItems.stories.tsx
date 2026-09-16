/**
 * CategoryAppearanceMenuItems Stories
 *
 * `CategoryAppearancePickerRow` は色・アイコンの属性行（#2406）。
 * `CategoryColorMenuItems` / `CategoryIconMenuItems` はこの行と、既存の
 * `CategoryHeader`（サイドバー見出しの「...」メニュー）から使われる。
 */

import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { CategoryAppearancePickerRow } from './CategoryAppearanceMenuItems';

import type { CategoryColorName } from '../lib/category-colors';

const meta = {
  title: 'Product/Features/Activities/CategoryAppearancePickerRow',
  component: CategoryAppearancePickerRow,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    color: null,
    icon: null,
    onColorChange: fn(),
    onIconChange: fn(),
  },
} satisfies Meta<typeof CategoryAppearancePickerRow>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Interactive Wrapper
// ─────────────────────────────────────────────────────────

function InteractivePickerRow() {
  const [color, setColor] = useState<CategoryColorName | null>(null);
  const [icon, setIcon] = useState<string | null>(null);

  return (
    <CategoryAppearancePickerRow
      color={color}
      onColorChange={setColor}
      icon={icon}
      onIconChange={setIcon}
    />
  );
}

/** 未選択状態。既定の自動割当（青・タグアイコン）でプレビューする。 */
export const Default: Story = {
  render: () => <InteractivePickerRow />,
};

/** 色を選ぶと即座にプレビューへ反映される。 */
export const SelectColor: Story = {
  render: () => <InteractivePickerRow />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '色を選択' }));

    const body = within(document.body);
    await userEvent.click(await body.findByText('緑'));
    await expect(
      (await canvas.findByRole('button', { name: '色を選択' })).querySelector('span'),
    ).toHaveClass('bg-category-green');
  },
};

/** アイコンを選ぶと即座にプレビューへ反映される。 */
export const SelectIcon: Story = {
  render: () => <InteractivePickerRow />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'アイコンを選択' }));

    const body = within(document.body);
    await userEvent.click(await body.findByRole('menuitem', { name: 'dumbbell' }));
    await expect(
      (await canvas.findByRole('button', { name: 'アイコンを選択' })).querySelector('svg'),
    ).toHaveClass('lucide-dumbbell');
  },
};

/** 既存カテゴリーの値（緑・briefcase）で初期化した状態。 */
export const Preselected: Story = {
  args: { color: 'green', icon: 'briefcase' },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <CategoryAppearancePickerRow
        color={null}
        onColorChange={() => {}}
        icon={null}
        onIconChange={() => {}}
      />
      <CategoryAppearancePickerRow
        color="green"
        onColorChange={() => {}}
        icon="briefcase"
        onIconChange={() => {}}
      />
      <CategoryAppearancePickerRow
        color="violet"
        onColorChange={() => {}}
        icon="book-open"
        onIconChange={() => {}}
      />
    </div>
  ),
};
