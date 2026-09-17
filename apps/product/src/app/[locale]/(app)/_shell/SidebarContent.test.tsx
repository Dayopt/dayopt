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
/** テンプレート保存モードの起動（サイドバーの「+」） */
const startSaving = vi.hoisted(() => vi.fn());
/** 適用 mutation の実行中フラグ。連打ガードの検証で切り替える */
const applyState = vi.hoisted(() => ({ isPending: false }));
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
  }: {
    templates: ReadonlyArray<{ id: string; name: string }>;
    onApplyTemplate?: (templateId: string) => void;
    onCreateTimeblock?: () => void;
  }) => (
    <div data-testid="template-list">
      {onCreateTimeblock && (
        <button type="button" onClick={onCreateTimeblock}>
          create-template
        </button>
      )}
      {templates.map((template) => (
        <button key={template.id} type="button" onClick={() => onApplyTemplate?.(template.id)}>
          {template.name}
        </button>
      ))}
    </div>
  ),
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
    renameTemplate: { mutate: vi.fn() },
    deleteTemplate: { mutate: vi.fn() },
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

  it('falls back to CalendarSidebar on workspace-external paths (e.g. /settings)', () => {
    pathnameMock.mockReturnValue('/settings');

    render(<SidebarContent />);

    expect(screen.getByTestId('view-switcher-list')).toBeInTheDocument();
  });
});
