import { OPEN_MENU_A11Y, verifyModalMenuFocus } from '@dayopt/components/testing/modal-menu';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { DropdownMenu, DropdownMenuTrigger } from '@dayopt/components';

import { ActivityRowMenu, type CategoryOption } from './ActivityRowMenu';

const CATEGORY_OPTIONS: CategoryOption[] = [
  { id: 'cat-work', name: '仕事', color: 'green', icon: 'briefcase' },
  { id: 'cat-study', name: '学習', color: 'orange', icon: 'book-open' },
  { id: 'cat-rest', name: '休息', color: 'blue', icon: null },
];

/**
 * アクティビティ行のメニュー。
 *
 * DnD 廃止に伴い、カテゴリーの付け替えは「カテゴリーを変更」→ ピッカーで行う（手数 3）。
 * 色・アイコンはカテゴリーだけが持つため、この menu には並ばない（`CategoryHeader` 側にある）。
 */
const meta = {
  title: 'Product/Features/Activities/ActivityRowMenu',
  component: ActivityRowMenu,
  tags: ['autodocs'],
  parameters: { layout: 'centered', a11y: OPEN_MENU_A11Y },
  args: {
    currentCategoryId: 'cat-work',
    categoryOptions: CATEGORY_OPTIONS,
    onOpenRenameDialog: fn(),
    onChangeCategory: fn(),
    onShowOnlyActivity: fn(),
    onViewStats: fn(),
    onArchiveActivity: fn(),
    onDeleteActivity: fn(),
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'メニューを開く' });
    await userEvent.click(trigger);
    await verifyModalMenuFocus(trigger);
    await expect(await within(document.body).findByRole('menu')).toBeVisible();
  },
  decorators: [
    (Story) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">メニューを開く</button>
        </DropdownMenuTrigger>
        <Story />
      </DropdownMenu>
    ),
  ],
} satisfies Meta<typeof ActivityRowMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** カテゴリーに所属しているアクティビティのメニュー。 */
export const InCategory: Story = {};

/** 未分類のアクティビティ。「カテゴリーなし」にチェックが入る。 */
export const Uncategorized: Story = {
  args: { currentCategoryId: null },
};

/** モバイル簡略版。表示切替 + アーカイブ + 削除のみ。 */
export const Mobile: Story = {
  args: { isMobile: true },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'メニューを開く' });
    await userEvent.click(trigger);
    await verifyModalMenuFocus(trigger);
    const body = within(document.body);
    await expect(body.getByText('このアクティビティだけ表示')).toBeInTheDocument();
    await expect(body.queryByText('カテゴリーを変更')).not.toBeInTheDocument();
  },
};

/** 「カテゴリーを変更」サブメニューを開いた状態（DnD の代替導線）。 */
export const CategoryPickerOpen: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'メニューを開く' });
    await userEvent.click(trigger);
    await verifyModalMenuFocus(trigger);
    const body = within(document.body);
    await userEvent.hover(body.getByText('カテゴリーを変更'));
    await expect(await body.findByText('カテゴリーなし')).toBeInTheDocument();
    await expect(await body.findByText('学習')).toBeInTheDocument();
  },
};

/** 全パターン一覧（メニューは Portal に出るため、状態ごとに個別 Story で確認する）。 */
export const AllPatterns: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'カテゴリー所属' });
    await userEvent.click(trigger);
    await verifyModalMenuFocus(trigger);
    await expect(await within(document.body).findByRole('menu')).toBeVisible();
  },
  render: () => (
    <div className="flex flex-col gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">カテゴリー所属</button>
        </DropdownMenuTrigger>
        <ActivityRowMenu
          currentCategoryId="cat-work"
          categoryOptions={CATEGORY_OPTIONS}
          onOpenRenameDialog={fn()}
          onChangeCategory={fn()}
          onShowOnlyActivity={fn()}
          onViewStats={fn()}
          onArchiveActivity={fn()}
          onDeleteActivity={fn()}
        />
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">未分類</button>
        </DropdownMenuTrigger>
        <ActivityRowMenu
          currentCategoryId={null}
          categoryOptions={CATEGORY_OPTIONS}
          onOpenRenameDialog={fn()}
          onChangeCategory={fn()}
          onShowOnlyActivity={fn()}
          onArchiveActivity={fn()}
          onDeleteActivity={fn()}
        />
      </DropdownMenu>
    </div>
  ),
};

/** 閉じた状態ではトリガーを含む全体を検査する。 */
export const Closed: Story = {
  parameters: { a11y: { context: { include: ['body'] } } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', { name: 'メニューを開く' }),
    ).toHaveAttribute('aria-expanded', 'false');
  },
};
