import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { CategoryHeader } from './CategoryHeader';

/**
 * カテゴリーの見出し行。
 *
 * 色 / アイコン + カテゴリー名 + 折りたたみシェブロン + メニュー。
 * **チェックボックスは置かない**（確定仕様）。所属アクティビティの一括表示は
 * メニューの「このカテゴリーだけ表示」で行う。DnD は廃止済みなので
 * ドラッグハンドルも並べ替え表現も無い。
 *
 * メニュー項目:
 *
 * | 項目                     | Desktop | Mobile |
 * | ------------------------ | :-----: | :----: |
 * | アクティビティを追加      |    ○    |   ×    |
 * | 名前を変更                |    ○    |   ×    |
 * | カラーを変更              |    ○    |   ×    |
 * | アイコンを変更            |    ○    |   ×    |
 * | このカテゴリーだけ表示     |    ○    |   ○    |
 * | アクティビティの詳細      |    ○    |   ×    |
 * | アーカイブ                |    ○    |   ○    |
 * | 削除                      |    ○    |   ×    |
 */
const meta = {
  title: 'Product/Features/Activities/CategoryHeader',
  component: CategoryHeader,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    // 内部でレンダリングするトグルボタンに対する button-name は component 側で aria-label 済み
    a11y: { test: 'todo' },
  },
  args: {
    label: '仕事',
    visibility: 'all',
    collapsed: false,
    displayColor: 'green',
    currentIcon: 'briefcase',
    onToggleCollapse: fn(),
    onShowOnlyCategory: fn(),
    onColorChange: fn(),
    onIconChange: fn(),
    onAddActivityToCategory: fn(),
    onRenameCategory: fn(),
    onArchiveCategory: fn(),
    onDeleteCategory: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CategoryHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 所属アクティビティが全て表示中。 */
export const AllVisible: Story = {};

/** 一部のみ表示中。見出しの見た目は all と同じ（muted になるのは none のときだけ）。 */
export const SomeVisible: Story = {
  args: { visibility: 'some' },
};

/** 所属アクティビティが全て非表示。見出しが muted になる。 */
export const NoneVisible: Story = {
  args: { visibility: 'none' },
};

/** 折りたたみ状態。シェブロンが右向き。 */
export const Collapsed: Story = {
  args: { collapsed: true },
};

/** 長いカテゴリー名。truncate が効く。 */
export const LongLabel: Story = {
  args: { label: 'とても長いカテゴリー名が入った場合の表示確認用テスト' },
};

/** メニューを開いた状態。色・アイコン・付け替え導線が並ぶ。 */
export const WithMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'カテゴリーメニュー' }));

    const body = within(document.body);
    await expect(body.getByText('アクティビティを追加')).toBeInTheDocument();
    await expect(body.getByText('名前を変更')).toBeInTheDocument();
    await expect(body.getByText('このカテゴリーだけ表示')).toBeInTheDocument();
    await expect(body.getByText('削除')).toBeInTheDocument();
  },
};

/** モバイル簡略版。「このカテゴリーだけ表示」+「アーカイブ」のみ。 */
export const WithMenuOpenMobile: Story = {
  args: { isMobile: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'カテゴリーメニュー' }));

    const body = within(document.body);
    await expect(body.getByText('このカテゴリーだけ表示')).toBeInTheDocument();
    await expect(body.getByText('アーカイブ')).toBeInTheDocument();
    await expect(body.queryByText('名前を変更')).not.toBeInTheDocument();
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-1">
      <CategoryHeader
        label="仕事"
        visibility="all"
        collapsed={false}
        displayColor="green"
        currentIcon="briefcase"
        onToggleCollapse={fn()}
        onShowOnlyCategory={fn()}
        onColorChange={fn()}
        onIconChange={fn()}
        onAddActivityToCategory={fn()}
        onRenameCategory={fn()}
        onDeleteCategory={fn()}
      />
      <CategoryHeader
        label="学習"
        visibility="some"
        collapsed={false}
        displayColor="orange"
        currentIcon="book-open"
        onToggleCollapse={fn()}
        onShowOnlyCategory={fn()}
        onColorChange={fn()}
        onIconChange={fn()}
        onAddActivityToCategory={fn()}
        onRenameCategory={fn()}
        onDeleteCategory={fn()}
      />
      <CategoryHeader
        label="休息"
        visibility="none"
        collapsed
        displayColor="blue"
        onToggleCollapse={fn()}
        onShowOnlyCategory={fn()}
        onColorChange={fn()}
        onAddActivityToCategory={fn()}
        onRenameCategory={fn()}
        onDeleteCategory={fn()}
      />
    </div>
  ),
};
