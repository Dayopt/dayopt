import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TREE = {
  categories: [
    {
      category: { id: 'cat-work', name: '仕事', color: 'blue', icon: 'briefcase' },
      activities: [
        { id: 'act-dev', name: '実装' },
        { id: 'act-mtg', name: '会議' },
      ],
    },
    {
      category: { id: 'cat-sleep', name: '睡眠', color: 'indigo', icon: 'moon' },
      activities: [{ id: 'act-nap', name: '昼寝' }],
    },
  ],
  uncategorized: [{ id: 'act-walk', name: '散歩' }],
};

const treeState = vi.hoisted(() => ({
  current: { data: undefined as unknown, isPending: false },
}));

/** `t(key, values)` は `key 値...` を返す。どの行の操作かを名前で引けるようにする。 */
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

vi.mock('@/features/activities', () => ({
  useActivityTree: () => treeState.current,
  ActivityIcon: () => <span data-testid="activity-icon" />,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

import { useReportViewStore } from '../../stores/useReportViewStore';
import { ReportFilterList } from './ReportFilterList';

function resetStore() {
  useReportViewStore.setState({
    hiddenCategoryIds: [],
    hiddenActivityIds: [],
  });
}

/** 行の 👁。見えている行は `hide 名前`、外している行は `show 名前` という名前を持つ。 */
function eye(action: 'show' | 'hide', name: string) {
  return screen.getByRole('button', { name: `${action} ${name}` });
}

/** 見出し（SidebarSection）の中身を引く。chevron の名前が見出しのタイトルと同じ。 */
function section(title: string) {
  const toggle = screen.getByRole('button', { name: title });
  const node = toggle.closest('section');
  if (node === null) throw new Error(`section not found: ${title}`);
  return node;
}

describe('ReportFilterList', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    treeState.current = { data: TREE, isPending: false };
  });

  /** 骨格はカレンダーのサイドバーと同じ「カテゴリ」「未分類」の 2 見出し。 */
  it('カテゴリの見出しにカテゴリー → アクティビティ、未分類の見出しに未分類のアクティビティを並べる', () => {
    render(<ReportFilterList />);

    const categories = section('categoriesHeading');
    for (const name of ['仕事', '実装', '会議', '睡眠', '昼寝']) {
      expect(within(categories).getByText(name)).toBeInTheDocument();
    }
    expect(within(categories).queryByText('散歩')).toBeNull();

    const uncategorized = section('uncategorized');
    expect(within(uncategorized).getByText('散歩')).toBeInTheDocument();
    // 未分類の見出し自体には出し入れの口が無い（カレンダーと同じ）
    expect(screen.queryByRole('button', { name: /^(show|hide) uncategorized$/ })).toBeNull();
  });

  it('チェックボックスもセグメントの口も持たない', () => {
    render(<ReportFilterList />);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(/segment|セグメント/i)).toBeNull();
  });

  describe('アクティビティの 👁', () => {
    it('押すとそのアクティビティだけが hidden に入り、行が muted になる', async () => {
      const user = userEvent.setup();
      render(<ReportFilterList />);

      await user.click(eye('hide', '実装'));

      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-dev']);
      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual([]);
      expect(screen.getByRole('button', { name: '実装', pressed: false })).toBeInTheDocument();
      expect(eye('hide', '会議')).toBeInTheDocument();
    });

    it('行の余白を押しても切り替わる', async () => {
      const user = userEvent.setup();
      render(<ReportFilterList />);

      const row = screen.getByText('会議').closest('[data-report-filter-row="activity"]');
      if (!(row instanceof HTMLElement)) throw new Error('row not found');
      await user.click(row);

      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-mtg']);
    });

    /**
     * カテゴリーが外れている間に子を押す意図は「この 1 行だけ見る」。カテゴリーだけを戻すと
     * 兄弟までまとめて出てしまうので、兄弟を個別に隠す。
     */
    it('カテゴリーが外れている間に押すと、その 1 行だけが見える状態になる', async () => {
      const user = userEvent.setup();
      useReportViewStore.setState({ hiddenCategoryIds: ['cat-work'] });
      render(<ReportFilterList />);

      await user.click(eye('show', '実装'));

      const state = useReportViewStore.getState();
      expect(state.hiddenCategoryIds).toEqual([]);
      expect(state.hiddenActivityIds).toEqual(['act-mtg']);
      expect(eye('hide', '実装')).toBeInTheDocument();
      expect(eye('show', '会議')).toBeInTheDocument();
    });

    it('未分類のアクティビティも個別に出し入れできる', async () => {
      const user = userEvent.setup();
      render(<ReportFilterList />);

      await user.click(eye('hide', '散歩'));
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-walk']);

      await user.click(eye('show', '散歩'));
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual([]);
    });
  });

  describe('カテゴリーの 👁', () => {
    it('全部見えている時に押すとカテゴリーごと外れ、配下も外れて見える', async () => {
      const user = userEvent.setup();
      render(<ReportFilterList />);

      await user.click(eye('hide', '睡眠'));

      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual(['cat-sleep']);
      expect(eye('show', '睡眠')).toBeInTheDocument();
      expect(eye('show', '昼寝')).toBeInTheDocument();
    });

    it('一部だけ外れている時に押すと配下の個別 hidden を解いて全部見せる', async () => {
      const user = userEvent.setup();
      useReportViewStore.setState({ hiddenActivityIds: ['act-dev', 'act-walk'] });
      render(<ReportFilterList />);

      await user.click(eye('show', '仕事'));

      // 別グループ（未分類の散歩）には触らない
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-walk']);
      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual([]);
      expect(eye('hide', '仕事')).toBeInTheDocument();
    });

    it('外れている時に押すとカテゴリーを戻し、配下の個別 hidden も解く', async () => {
      const user = userEvent.setup();
      useReportViewStore.setState({
        hiddenCategoryIds: ['cat-work'],
        hiddenActivityIds: ['act-dev'],
      });
      render(<ReportFilterList />);

      await user.click(eye('show', '仕事'));

      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual([]);
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual([]);
    });
  });

  describe('折りたたみ', () => {
    /** カレンダーの `CategoryHeader` と同じく、見出し行のどこを押しても開閉する。 */
    it('カテゴリー見出しの行を押すと配下が畳まれ、フィルタの状態は変わらない', async () => {
      const user = userEvent.setup();
      useReportViewStore.setState({ hiddenActivityIds: ['act-dev'] });
      render(<ReportFilterList />);

      const header = screen.getByText('仕事').closest('[data-report-filter-row="category"]');
      if (!(header instanceof HTMLElement)) throw new Error('header not found');
      await user.click(header);

      expect(screen.queryByText('実装')).toBeNull();
      expect(screen.getByRole('button', { name: 'expandCategory 仕事' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-dev']);
    });

    it('未分類の見出しも畳める', async () => {
      const user = userEvent.setup();
      render(<ReportFilterList />);

      await user.click(screen.getByRole('button', { name: 'uncategorized' }));

      expect(screen.queryByText('散歩')).toBeNull();
    });
  });

  it('カテゴリーも未分類も無ければ、それぞれの見出しに空の文言を出す', () => {
    treeState.current = { data: { categories: [], uncategorized: [] }, isPending: false };
    render(<ReportFilterList />);

    expect(within(section('categoriesHeading')).getByRole('status')).toHaveTextContent('empty');
    expect(within(section('uncategorized')).getByRole('status')).toHaveTextContent(
      'noUncategorized',
    );
  });

  /**
   * 空状態を一覧の**中**へ入れない（#2752）。`role="status"` は list の子として
   * 許されず、`<ul>` 直下に置くと axe が 2 つ違反を出す（role が要素に不許可 /
   * list の直下に許されない子）。テキストの有無だけを見る上の test では、
   * 一覧の中へ戻しても緑のまま通ってしまう。
   */
  it('空状態は一覧（role=list）の外に置く', () => {
    treeState.current = { data: { categories: [], uncategorized: [] }, isPending: false };
    render(<ReportFilterList />);

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.closest('[role="list"], ul, ol')).toBeNull();
    }
  });

  it('読み込み中は骨組みを出す', () => {
    treeState.current = { data: undefined, isPending: true };
    render(<ReportFilterList />);

    expect(screen.queryByText('categoriesHeading')).toBeNull();
  });
});
