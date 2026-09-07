/**
 * ActivityQuickSelector Stories
 *
 * アクティビティ選択フローティングパネル。PC はアンカー横のパネル、モバイルは
 * vaul Drawer。カテゴリー数が 2 つ以上なら上部に絞り込みチップ行が出る。
 *
 * tRPC の activities.listTree をモックして一覧を供給する。
 */

import { useRef, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { SegmentedControl } from '@dayopt/components';

import { ActivityQuickSelector } from './ActivityQuickSelector';

import type { ActivityTree } from '../types';

const TIMESTAMPS = {
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
};

const USER_ID = 'storybook-user';

function category(id: string, name: string, color: string, icon: string) {
  return { id, user_id: USER_ID, name, color, icon, archived_at: null, ...TIMESTAMPS };
}

function activity(id: string, name: string, categoryId: string | null) {
  return { id, user_id: USER_ID, name, category_id: categoryId, archived_at: null, ...TIMESTAMPS };
}

/** カテゴリー 2 つ + 未分類。チップ行が出る最小構成 */
const ACTIVITY_TREE = {
  categories: [
    {
      category: category('work', '仕事', 'blue', 'briefcase'),
      activities: [
        activity('development', '開発', 'work'),
        activity('meeting', '会議', 'work'),
        activity('review', 'レビュー', 'work'),
      ],
    },
    {
      category: category('life', '生活', 'green', 'heart'),
      activities: [activity('meal', '食事', 'life'), activity('sleep', '睡眠', 'life')],
    },
  ],
  uncategorized: [activity('workout', '運動', null)],
} satisfies ActivityTree;

/** カテゴリー 1 つだけ。絞り込む意味が無いのでチップ行は出ない */
const SINGLE_CATEGORY_TREE = {
  categories: [
    {
      category: category('work', '仕事', 'blue', 'briefcase'),
      activities: [activity('development', '開発', 'work')],
    },
  ],
  uncategorized: [],
} satisfies ActivityTree;

/** カテゴリー多数。チップ行の横スクロールと一覧の縦スクロールを確認する */
const MANY_CATEGORIES_TREE = {
  categories: Array.from({ length: 8 }, (_, i) => ({
    category: category(`cat-${i}`, `カテゴリー ${i + 1}`, 'blue', 'briefcase'),
    activities: Array.from({ length: 4 }, (_, j) =>
      activity(`act-${i}-${j}`, `アクティビティ ${i + 1}-${j + 1}`, `cat-${i}`),
    ),
  })),
  uncategorized: [],
} satisfies ActivityTree;

const EMPTY_TREE = { categories: [], uncategorized: [] } satisfies ActivityTree;

const meta = {
  title: 'Product/Features/Activities/ActivityQuickSelector',
  component: ActivityQuickSelector,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    open: true,
    onOpenChange: fn(),
    onSelect: fn(),
    onCreateAndSelect: fn(),
  },
} satisfies Meta<typeof ActivityQuickSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

/** PC: アンカー要素の横にパネルを開く */
function renderAnchored(hint?: React.ReactNode) {
  function Renderer() {
    const anchorRef = useRef<HTMLDivElement>(null);

    return (
      <div className="h-[520px] w-[720px]">
        <div
          ref={anchorRef}
          className="border-border bg-card flex h-24 w-40 items-center justify-center rounded-lg border text-sm"
        >
          アンカー
        </div>
        <ActivityQuickSelector
          open
          onOpenChange={fn()}
          onSelect={fn()}
          onCreateAndSelect={fn()}
          anchorRef={anchorRef}
          hint={hint}
        />
      </div>
    );
  }

  return <Renderer />;
}

/** 既定。カテゴリーチップ行 + 見出しごとのアクティビティ pill。 */
export const Default: Story = {
  parameters: { trpcMocks: { 'activities.listTree': ACTIVITY_TREE } },
  render: () => renderAnchored(),
};

/** カテゴリーが 1 つだけの時はチップ行を出さない。 */
export const SingleCategory: Story = {
  parameters: { trpcMocks: { 'activities.listTree': SINGLE_CATEGORY_TREE } },
  render: () => renderAnchored(),
};

/** カテゴリー多数。チップ行は横スクロール、一覧だけが縦スクロールする。 */
export const ManyCategories: Story = {
  parameters: { trpcMocks: { 'activities.listTree': MANY_CATEGORIES_TREE } },
  render: () => renderAnchored(),
};

/** アクティビティ 0 件。サンプル候補を出す。 */
export const EmptyActivities: Story = {
  parameters: { trpcMocks: { 'activities.listTree': EMPTY_TREE } },
  render: () => renderAnchored(),
};

/** hint スロットにドラッグ作成の種別タブを差した状態（呼び出し側が組み立てる）。 */
export const WithKindTabs: Story = {
  parameters: { trpcMocks: { 'activities.listTree': ACTIVITY_TREE } },
  render: () => {
    function KindHint() {
      const [kind, setKind] = useState<'record' | 'plan'>('record');

      return (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-muted-foreground truncate text-sm">7/14 (月) 09:00 – 10:00</p>
          <SegmentedControl
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'record', label: '記録' },
              { value: 'plan', label: '予定' },
            ]}
            ariaLabel="作成する種別"
            size="sm"
          />
        </div>
      );
    }

    return renderAnchored(<KindHint />);
  },
};

/** モバイル: vaul Drawer。同じチップ行と一覧構造を使う。 */
export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
    layout: 'fullscreen',
    trpcMocks: { 'activities.listTree': ACTIVITY_TREE },
  },
  render: () => (
    <div className="bg-background min-h-[560px]">
      <ActivityQuickSelector open onOpenChange={fn()} onSelect={fn()} onCreateAndSelect={fn()} />
    </div>
  ),
};

/** 全パターンの基準となるインタラクティブ表示。 */
export const AllPatterns: Story = {
  parameters: { trpcMocks: { 'activities.listTree': ACTIVITY_TREE } },
  render: () => renderAnchored(),
};
