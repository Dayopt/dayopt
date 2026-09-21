import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.hoisted(() => vi.fn(() => '/calendar'));

vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: pathnameMock,
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const applyMutate = vi.hoisted(() => vi.fn());
const renameMutate = vi.hoisted(() => vi.fn());
const deleteMutate = vi.hoisted(() => vi.fn());
/** テンプレート保存モードの起動（サイドバーの「+」） */
const startSaving = vi.hoisted(() => vi.fn());
/** 適用 mutation の実行中フラグ。連打ガードの検証で切り替える */
const applyState = vi.hoisted(() => ({ isPending: false }));
const accessMocks = vi.hoisted(() => {
  const state = { canUseProduct: true };
  const openSettings = vi.fn();
  const gateProductAccess = vi.fn((run: () => void) => {
    if (state.canUseProduct) run();
    else openSettings('billing');
  });
  return { state, openSettings, gateProductAccess };
});
const templateRows = vi.hoisted(() => [
  {
    id: 'template-1',
    name: '朝のルーティン',
    blocks: [
      {
        id: 'block-1',
        activityId: null,
        title: '集中',
        anchorMinute: 540,
        previewDurationMinutes: 60,
      },
    ],
  },
]);

vi.mock('@/features/calendar', () => ({
  resolveWorkspaceTab: (pathname: string) =>
    pathname === '/calendar' ? 'calendar' : pathname === '/report' ? 'report' : 'other',
  formatCalendarDateParam: () => '2026-03-25',
  useCalendarNavigation: () => null,
  // カレンダーが表示中の日（壁時計 Date）。テンプレート適用の宛先になる
  useCalendarNavigationStore: (selector: (state: { viewedDate: Date }) => unknown) =>
    selector({ viewedDate: new Date(2026, 2, 25) }),
  useTemplateSaveStore: (
    selector: (state: { startSaving: (dateKey: string) => void }) => unknown,
  ) => selector({ startSaving }),
  toTemplateView: (template: { id: string; name: string }) => ({ ...template, blocks: [] }),
  ActivityFilterList: ({
    betweenCategoriesAndUncategorized,
  }: {
    betweenCategoriesAndUncategorized?: React.ReactNode;
  }) => <div data-testid="activity-filter-list">{betweenCategoriesAndUncategorized}</div>,
  ViewSwitcherList: () => <div data-testid="view-switcher-list" />,
  TemplateList: ({
    templates,
    onApplyTemplate,
    onCreateTimeblock,
    onRenameTemplate,
    onDeleteTemplate,
  }: {
    templates: ReadonlyArray<{ id: string; name: string }>;
    onApplyTemplate?: (templateId: string) => void;
    onCreateTimeblock?: () => void;
    onRenameTemplate?: (templateId: string, name: string) => void;
    onDeleteTemplate?: (templateId: string) => void;
  }) => (
    <div data-testid="template-list">
      {onCreateTimeblock && (
        <button type="button" onClick={onCreateTimeblock}>
          create-template
        </button>
      )}
      {templates.map((template) => (
        <div key={template.id}>
          <button type="button" onClick={() => onApplyTemplate?.(template.id)}>
            {template.name}
          </button>
          <button type="button" onClick={() => onRenameTemplate?.(template.id, '新しい名前')}>
            rename-template
          </button>
          <button type="button" onClick={() => onDeleteTemplate?.(template.id)}>
            delete-template
          </button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/lib/billing/useProductAccessGate', () => ({
  useProductAccessGate: () => accessMocks.gateProductAccess,
}));

vi.mock('@/lib/trpc', () => ({
  api: { planTemplates: { list: { useQuery: () => ({ data: templateRows }) } } },
}));

vi.mock('@/features/activities', () => ({
  useActivitiesMap: () => ({ getActivityById: () => undefined }),
}));

vi.mock('@/features/timeblock', () => ({
  usePlanTemplateMutations: () => ({
    applyToDay: { mutate: applyMutate, isPending: applyState.isPending },
    renameTemplate: { mutate: renameMutate },
    deleteTemplate: { mutate: deleteMutate },
  }),
}));

vi.mock('@/components/ui/inputs/mini-calendar', () => ({
  MiniCalendar: () => <div data-testid="mini-calendar" />,
}));

vi.mock('@/features/review', () => ({
  ReportFilterList: () => <div data-testid="report-filter-list" />,
}));

vi.mock('@/lib/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));

import { SidebarContent } from './SidebarContent';

describe('SidebarContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyState.isPending = false;
    accessMocks.state.canUseProduct = true;
    pathnameMock.mockReturnValue('/calendar');
  });

  it('renders CalendarSidebar (view switcher + activity filter + templates) on /calendar', () => {
    render(<SidebarContent />);

    expect(screen.getByTestId('view-switcher-list')).toBeInTheDocument();
    expect(screen.getByTestId('activity-filter-list')).toBeInTheDocument();
    expect(screen.getByTestId('template-list')).toBeInTheDocument();
  });

  it('テンプレート列は ActivityFilterList の betweenCategoriesAndUncategorized slot（カテゴリの下・未分類の上）へ渡す', () => {
    render(<SidebarContent />);

    const activityFilter = screen.getByTestId('activity-filter-list');
    const templateList = screen.getByTestId('template-list');

    // 実際の「カテゴリ→未分類」間の挿入位置は ActivityFilterList 自身が保証する
    // （betweenCategoriesAndUncategorized slot、ActivityFilterList.tsx）。
    // ここでは CalendarSidebar が正しい slot にテンプレート列を渡していることだけを確認する
    expect(activityFilter.contains(templateList)).toBe(true);
  });

  it('renders ReportSidebar（分析フィルタだけ、calendar の view-switcher/activity-filter は出さない）on /report', () => {
    pathnameMock.mockReturnValue('/report');

    render(<SidebarContent />);

    expect(screen.queryByTestId('view-switcher-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-filter-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('template-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('report-filter-list')).toBeInTheDocument();
  });

  it('取得したテンプレートを一覧へ渡し、クリックで表示中の日へ適用する（#2567）', () => {
    render(<SidebarContent />);

    fireEvent.click(screen.getByRole('button', { name: '朝のルーティン' }));

    expect(applyMutate).toHaveBeenCalledWith({ templateId: 'template-1', date: '2026-03-25' });
  });

  it('利用権があれば改名を送る', () => {
    render(<SidebarContent />);

    fireEvent.click(screen.getByRole('button', { name: 'rename-template' }));

    expect(renameMutate).toHaveBeenCalledWith({ templateId: 'template-1', name: '新しい名前' });
  });

  it('見出しの「+」で、表示中の日をテンプレートとして保存するモードに入る', () => {
    render(<SidebarContent />);

    fireEvent.click(screen.getByRole('button', { name: 'create-template' }));

    expect(startSaving).toHaveBeenCalledWith('2026-03-25');
  });

  it('適用中はもう一度クリックしても送らない（2 通目は必ず重複で失敗し、巻き戻しが 1 通目を消す）', () => {
    applyState.isPending = true;

    render(<SidebarContent />);
    fireEvent.click(screen.getByRole('button', { name: '朝のルーティン' }));

    expect(applyMutate).not.toHaveBeenCalled();
  });

  it('利用権が無い時は適用・改名を送らず課金設定を開く', () => {
    accessMocks.state.canUseProduct = false;

    render(<SidebarContent />);

    fireEvent.click(screen.getByRole('button', { name: '朝のルーティン' }));
    fireEvent.click(screen.getByRole('button', { name: 'rename-template' }));

    expect(applyMutate).not.toHaveBeenCalled();
    expect(renameMutate).not.toHaveBeenCalled();
    expect(accessMocks.openSettings).toHaveBeenCalledTimes(2);
    expect(accessMocks.openSettings).toHaveBeenLastCalledWith('billing');
  });

  it('利用権が無くても削除は送る', () => {
    accessMocks.state.canUseProduct = false;

    render(<SidebarContent />);
    fireEvent.click(screen.getByRole('button', { name: 'delete-template' }));

    expect(deleteMutate).toHaveBeenCalledWith({ templateId: 'template-1' });
    expect(accessMocks.openSettings).not.toHaveBeenCalled();
  });

  it('falls back to CalendarSidebar on workspace-external paths (e.g. /settings)', () => {
    pathnameMock.mockReturnValue('/settings');

    render(<SidebarContent />);

    expect(screen.getByTestId('view-switcher-list')).toBeInTheDocument();
  });
});
