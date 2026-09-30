import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Copy, Ellipsis, ExternalLink, Pencil, Settings } from 'lucide-react';

import { FloatingActionBar, FloatingActionBarItem } from './floating-action-bar';

function ActionItems({ disabled = false }: { disabled?: boolean }) {
  return (
    <>
      <FloatingActionBarItem disabled={disabled}>
        <Pencil aria-hidden="true" />
        編集
      </FloatingActionBarItem>
      <FloatingActionBarItem disabled={disabled}>
        <Copy aria-hidden="true" />
        複製
      </FloatingActionBarItem>
      <FloatingActionBarItem disabled={disabled}>
        <Ellipsis aria-hidden="true" />
        その他
      </FloatingActionBarItem>
    </>
  );
}

function LinkItems() {
  return (
    <>
      <FloatingActionBarItem asChild>
        <a href="#details">
          <ExternalLink aria-hidden="true" />
          詳細
        </a>
      </FloatingActionBarItem>
      <FloatingActionBarItem asChild>
        <a href="#settings">
          <Settings aria-hidden="true" />
          設定
        </a>
      </FloatingActionBarItem>
    </>
  );
}

const meta = {
  title: 'Shared/Components/Actions/FloatingActionBar',
  component: FloatingActionBar,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'FloatingActionBar が共通の背景と配置を担当し、FloatingActionBarItem の children に任意のアイコンとラベルを渡します。onClick でボタンの操作、asChild で a やルーターの Link を配置できます。画面内の余白や固定位置は利用側で指定します。',
      },
    },
  },
  args: { children: <ActionItems /> },
  argTypes: { children: { control: false } },
} satisfies Meta<typeof FloatingActionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** アイコンとラベルを持つ3つの操作。 */
export const Default: Story = {};

/** 任意のリンク先を持つ2つの操作。 */
export const Links: Story = {
  args: { children: <LinkItems /> },
};

/** 操作できない状態。 */
export const Disabled: Story = {
  args: { children: <ActionItems disabled /> },
};

/** ラベルを表示しない操作。アクセシブルな名前を指定する。 */
export const IconOnly: Story = {
  args: {
    children: (
      <>
        <FloatingActionBarItem icon aria-label="編集">
          <Pencil aria-hidden="true" />
        </FloatingActionBarItem>
        <FloatingActionBarItem icon aria-label="その他">
          <Ellipsis aria-hidden="true" />
        </FloatingActionBarItem>
      </>
    ),
  },
};

/** ボタンとリンクを同じバーに配置する。 */
export const Mixed: Story = {
  args: {
    children: (
      <>
        <FloatingActionBarItem>
          <Pencil aria-hidden="true" />
          編集
        </FloatingActionBarItem>
        <FloatingActionBarItem asChild>
          <a href="#details">
            <ExternalLink aria-hidden="true" />
            詳細
          </a>
        </FloatingActionBarItem>
      </>
    ),
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-center gap-6">
      <FloatingActionBar>
        <ActionItems />
      </FloatingActionBar>
      <FloatingActionBar>
        <LinkItems />
      </FloatingActionBar>
      <FloatingActionBar>
        <ActionItems disabled />
      </FloatingActionBar>
      <FloatingActionBar>{IconOnly.args?.children}</FloatingActionBar>
      <FloatingActionBar>{Mixed.args?.children}</FloatingActionBar>
    </div>
  ),
};
