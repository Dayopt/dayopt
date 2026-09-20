/**
 * ActivityFilterList Stories
 *
 * サイドバーのアクティビティ一覧。IA は上から
 * カテゴリー見出し（+ ネストしたアクティビティ）→「未分類」→「アクティビティなし」行
 * →「アーカイブ済み」の順。DnD は廃止済み。
 *
 * tRPC で activities.listTree / activities.listActivities / statistics.getActivityStats を
 * モックし、useCalendarFilterStore は storeMocks で初期化する。
 */

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fireEvent, within } from 'storybook/test';

import { ActivityFilterList } from './ActivityFilterList';

const TIMESTAMPS = {
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function activity(id: string, name: string, categoryId: string | null = null) {
  return { id, name, user_id: 'user-1', category_id: categoryId, archived_at: null, ...TIMESTAMPS };
}

function category(id: string, name: string, color: string, icon: string | null) {
  return { id, name, user_id: 'user-1', color, icon, archived_at: null, ...TIMESTAMPS };
}

const WORK = category('cat-work', '仕事', 'blue', 'briefcase');
const STUDY = category('cat-study', '学習', 'green', 'book-open');
const UNCATEGORIZED = [activity('act-workout', '運動'), activity('act-rest', '休憩')];

/** サーバーの listTree と同じ形（カテゴリーごとの所属 + 未分類） */
const MOCK_TREE = {
  categories: [
    {
      category: WORK,
      activities: [
        activity('act-meeting', '会議', 'cat-work'),
        activity('act-dev', '実装', 'cat-work'),
      ],
    },
    { category: STUDY, activities: [activity('act-reading', '読書', 'cat-study')] },
  ],
  uncategorized: UNCATEGORIZED,
};

const ALL_ACTIVITY_IDS = ['act-meeting', 'act-dev', 'act-reading', 'act-workout', 'act-rest'];

/** アーカイブ済み（listTree には出ず、末尾の折りたたみセクションにだけ並ぶ） */
const ARCHIVED_ACTIVITY = {
  ...activity('act-archived', '旧タスク整理'),
  archived_at: '2026-08-01T00:00:00.000Z',
};
const ARCHIVED_CATEGORY = {
  ...category('cat-archived', '一時プロジェクト', 'violet', 'folder'),
  archived_at: '2026-08-01T00:00:00.000Z',
};

const LIVE_ACTIVITIES = [...MOCK_TREE.categories.flatMap((c) => c.activities), ...UNCATEGORIZED];

/**
 * `listActivities` / `listCategories` はアーカイブ済みを含めて 1 本引く実装なので、
 * ここでも同じ形（現役 + アーカイブ済み）でモックする。通常表示とアーカイブ済みの
 * 出し分けは client 側の絞り込みが担う。
 */
const MOCK_TRPC = {
  'activities.listTree': MOCK_TREE,
  'activities.listActivities': [...LIVE_ACTIVITIES, ARCHIVED_ACTIVITY],
  'activities.listCategories': [WORK, STUDY, ARCHIVED_CATEGORY],
  'statistics.getActivityStats': {
    counts: {},
    planCounts: {},
    lastUsed: {},
    medianMinutes: {},
  },
};

const meta = {
  title: 'Product/Features/Activities/ActivityFilterList',
  component: ActivityFilterList,
  parameters: {
    layout: 'padded',
    a11y: { test: 'todo' },
    trpcMocks: MOCK_TRPC,
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-60">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityFilterList>;

export default meta;

/**
 * 実ブラウザの `DragEvent` は `dataTransfer` に本物の `DataTransfer` しか受け取らない
 * （プレーンオブジェクトを渡すと "Failed to convert value to 'DataTransfer'" で落ちる）。
 * jsdom 側には構築子が無いので、無ければ最小限の代用を返す。
 */
function createDataTransfer(): DataTransfer {
  if (typeof DataTransfer !== 'undefined') return new DataTransfer();

  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  } as unknown as DataTransfer;
}

type Story = StoryObj<typeof meta>;

/**
 * 既定状態。カテゴリー（仕事 / 学習）が上に展開表示され、
 * その下に「未分類」見出しと未所属アクティビティ（テキストのみ）、末尾にアーカイブ済み。
 */
export const Default: Story = {
  parameters: {
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(ALL_ACTIVITY_IDS),
        initialized: true,
      },
    },
  },
};

/** 一部のアクティビティを非表示にした状態（ラベルが muted になる）。 */
export const PartiallyHidden: Story = {
  parameters: {
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(['act-meeting', 'act-reading']),
        initialized: true,
      },
    },
  },
};

/** カテゴリーが 1 つも無く、未分類だけが並ぶ状態。 */
export const UncategorizedOnly: Story = {
  parameters: {
    trpcMocks: {
      ...MOCK_TRPC,
      'activities.listTree': { categories: [], uncategorized: UNCATEGORIZED },
      'activities.listActivities': UNCATEGORIZED,
      'activities.listCategories': [],
    },
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(['act-workout', 'act-rest']),
        initialized: true,
      },
    },
  },
};

/**
 * 現役カテゴリーが 0 件で、アーカイブ済みだけが存在する状態。
 *
 * 表示メニューでステータスを切り替えた時に、見出しの有無がデータ（カテゴリーが
 * 存在するか）で決まり、フィルタでは変わらないことを確認するための story。
 * ここでは現役カテゴリーが無いので「カテゴリ」見出しはどのステータスでも出ず、
 * アーカイブ済みカテゴリーは「未分類」の中に並ぶ。
 */
export const ArchivedWithoutCategories: Story = {
  parameters: {
    trpcMocks: {
      ...MOCK_TRPC,
      'activities.listTree': { categories: [], uncategorized: UNCATEGORIZED },
      'activities.listActivities': [...UNCATEGORIZED, ARCHIVED_ACTIVITY],
      'activities.listCategories': [ARCHIVED_CATEGORY],
    },
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(['act-workout', 'act-rest']),
        initialized: true,
      },
    },
  },
};

/** 空状態。アクティビティが 1 件も無い新規ユーザー向け。 */
export const EmptyState: Story = {
  parameters: {
    trpcMocks: {
      ...MOCK_TRPC,
      'activities.listTree': { categories: [], uncategorized: [] },
      'activities.listActivities': [],
      'activities.listCategories': [],
    },
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(),
        initialized: false,
      },
    },
  },
};

/** ローディング状態。スケルトンが出る。 */
export const Loading: Story = {
  parameters: { trpcPending: true },
};

/**
 * ドラッグ中の見え方（所属変更 DnD）。
 *
 * ドラッグは静的に描けないので `play` で実際に `dragstart` → `dragover` を流し、
 * 掴んだ行（`bg-state-dragged`）とドロップ先のリング（`ring-ring`）が
 * 同時に見える瞬間で止める。test 専用の初期状態 prop を足すのではなく本物の
 * ハンドラを通すことで、Story が実装の証跡になる。
 */
export const DraggingOverValidTarget: Story = {
  parameters: {
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(ALL_ACTIVITY_IDS),
        initialized: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (await canvas.findByText('会議')).closest('[draggable="true"]');
    if (!row) throw new Error('drag source row not found');

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(row, { dataTransfer });

    // 「学習」カテゴリーの箱をドロップ先にする
    const target = (await canvas.findByText('学習')).closest('.rounded-lg')?.parentElement;
    if (target) fireEvent.dragOver(target, { dataTransfer });
  },
};

/**
 * 掴んだ行が今いるカテゴリーの上にいる状態。禁止表現は作らず、
 * **ハイライトを出さない**ことで伝える（カーソルはブラウザが no-drop にする）。
 */
export const DraggingOverInvalidTarget: Story = {
  parameters: {
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(ALL_ACTIVITY_IDS),
        initialized: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (await canvas.findByText('会議')).closest('[draggable="true"]');
    if (!row) throw new Error('drag source row not found');

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(row, { dataTransfer });

    // 掴んだ本人が属する「仕事」の上へ。ここは光らない
    const ownGroup = (await canvas.findByText('仕事')).closest('.rounded-lg')?.parentElement;
    if (ownGroup) fireEvent.dragOver(ownGroup, { dataTransfer });
  },
};

/**
 * 並び替えを「最終アクティビティ」にした状態。
 *
 * 使った日時が新しいものが上に来て、**一度も使っていないものは末尾**へ回る
 * （0 件のものが「古い」扱いで上位に混ざると、よく使うものを上げるという
 * 目的が壊れるため）。カテゴリー配下と未分類の両方へ一様にかかり、
 * カテゴリー自体の順序は名前順のまま動かない。
 */
export const SortedByLastUsed: Story = {
  parameters: {
    trpcMocks: {
      ...MOCK_TRPC,
      'statistics.getActivityStats': {
        counts: {},
        planCounts: {},
        medianMinutes: {},
        lastUsed: {
          // 「仕事」内: 実装 > 会議 の順になる（名前順なら 会議 が先）
          'act-dev': '2026-09-03T09:00:00.000Z',
          'act-meeting': '2026-09-01T09:00:00.000Z',
          // 未分類: 休憩 が先、運動 は未使用なので末尾（名前順なら 運動 が先）
          'act-rest': '2026-09-02T09:00:00.000Z',
        },
      },
    },
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(ALL_ACTIVITY_IDS),
        initialized: true,
      },
      useActivitySortStore: { sortKey: 'lastUsed' },
    },
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  parameters: {
    storeMocks: {
      useCalendarFilterStore: {
        visibleActivityIds: new Set(ALL_ACTIVITY_IDS),
        initialized: true,
      },
    },
  },
};
