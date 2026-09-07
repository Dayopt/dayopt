import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Command, CommandList } from '@dayopt/components';

import type { TimeblockSearchResult } from '../../lib/timeblock-search-results';
import { TimeblockSearchContent, TimeblockSearchDialog } from './TimeblockSearchDialog';

const mockPlansUseQuery = vi.fn();
const mockRecordsUseQuery = vi.fn();
const mockPlanRefetch = vi.fn();
const mockRecordRefetch = vi.fn();
const mockActivitiesRefetch = vi.fn();
const mockArchivedActivitiesRefetch = vi.fn();

const PLAN_ROW = {
  id: 'plan-1',
  title: 'Legacy deep work title',
  note: 'Outline the product iteration',
  activity_id: 'activity-work',
  start_at: '2026-07-15T00:00:00.000Z',
  end_at: '2026-07-15T01:00:00.000Z',
};

function successfulQuery(data: unknown[]) {
  return {
    data,
    error: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: data === MOCK_PLAN_ROWS ? mockPlanRefetch : mockRecordRefetch,
  };
}

const MOCK_PLAN_ROWS = [PLAN_ROW];

vi.mock('@/features/activities', () => ({
  ActivityIcon: ({ neutral }: { neutral?: boolean }) => (
    <span data-testid="activity-icon" data-uncategorized={String(!!neutral)} />
  ),
  // 名前・継承色の解決は現役 + アーカイブ済みをまとめた 1 つの map が担う
  useActivitiesMap: () => ({
    activitiesMap: new Map([
      ['activity-work', { id: 'activity-work', name: 'Work', color: 'blue', icon: 'briefcase' }],
      [
        'activity-archived',
        { id: 'activity-archived', name: 'Retired Project', color: 'rose', icon: 'archive' },
      ],
    ]),
    isLoading: false,
  }),
  useActivities: () => ({
    data: [{ id: 'activity-work', name: 'Work' }],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mockActivitiesRefetch,
  }),
  useArchivedActivities: () => ({
    data: [{ id: 'activity-archived', name: 'Retired Project' }],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mockArchivedActivitiesRefetch,
  }),
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (
    selector: (preferences: { timezone: string; timeFormat: '24h' }) => unknown,
  ) => selector({ timezone: 'Asia/Tokyo', timeFormat: '24h' }),
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    plans: { list: { useQuery: (...args: unknown[]) => mockPlansUseQuery(...args) } },
    records: { list: { useQuery: (...args: unknown[]) => mockRecordsUseQuery(...args) } },
  },
}));

function renderDialog(overrides: Partial<React.ComponentProps<typeof TimeblockSearchDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onOpenResult: vi.fn(),
    ...overrides,
  };
  render(<TimeblockSearchDialog {...props} />);
  return props;
}

describe('TimeblockSearchDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockPlansUseQuery.mockImplementation(() => successfulQuery(MOCK_PLAN_ROWS));
    mockRecordsUseQuery.mockImplementation(() => successfulQuery([]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空の検索語ではqueryを無効にし、300ms後に検索条件を渡す', async () => {
    renderDialog();

    expect(screen.getByRole('dialog').querySelector('[data-sentry-block]')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    expect(mockPlansUseQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '' }),
      expect.objectContaining({ enabled: false, meta: { persist: false } }),
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: ' work ' } });
    expect(mockPlansUseQuery).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ enabled: false }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockPlansUseQuery).toHaveBeenLastCalledWith(
      {
        search: 'work',
        sortBy: 'start_at',
        sortOrder: 'desc',
        limit: 21,
      },
      expect.objectContaining({ enabled: true, gcTime: 0, meta: { persist: false } }),
    );
    expect(mockRecordsUseQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'work' }),
      expect.objectContaining({ enabled: true, gcTime: 0, meta: { persist: false } }),
    );
  });

  it('アーカイブ済みアクティビティのブロックも正しい名前で表示する（アクティビティなしに落ちない、#1576）', async () => {
    const archivedActivityPlan = {
      id: 'plan-2',
      title: 'Old archived project',
      note: null,
      activity_id: 'activity-archived',
      start_at: '2026-05-01T00:00:00.000Z',
      end_at: '2026-05-01T01:00:00.000Z',
    };
    mockPlansUseQuery.mockImplementation(() => ({
      data: [archivedActivityPlan],
      error: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mockPlanRefetch,
    }));

    renderDialog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'archived' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getByText('Retired Project')).toBeInTheDocument();
    expect(screen.queryByText('calendar.filter.noActivity')).not.toBeInTheDocument();
  });

  it('結果を選ぶとopen callbackを呼び、検索語をリセットして閉じる', async () => {
    const onOpenChange = vi.fn();
    const onOpenResult = vi.fn();
    renderDialog({ onOpenChange, onOpenResult });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByText('Legacy deep work title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Work'));

    expect(onOpenResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'plan-1', kind: 'plan' }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenResult.mock.invocationCallOrder[0]!,
    );
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('閉じる操作で検索語をリセットする', () => {
    const props = renderDialog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('モバイル用キャンセル操作で検索語をリセットして閉じる', () => {
    const props = renderDialog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });

    fireEvent.click(screen.getByRole('button', { name: 'common.actions.cancel' }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('controlled openが外部からfalseになった場合も検索語を破棄する', async () => {
    const props = {
      onOpenChange: vi.fn(),
      onOpenResult: vi.fn(),
    };
    const { rerender } = render(<TimeblockSearchDialog open {...props} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    rerender(<TimeblockSearchDialog open={false} {...props} />);
    rerender(<TimeblockSearchDialog open {...props} />);

    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(mockPlansUseQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '' }),
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe('TimeblockSearchContent', () => {
  const result: TimeblockSearchResult = {
    kind: 'record',
    id: 'record-1',
    note: 'Calendar search states',
    activityId: 'activity-work',
    startAt: '2026-07-14T01:30:00.000Z',
    endAt: '2026-07-14T02:30:00.000Z',
  };

  function renderContent(
    overrides: Partial<React.ComponentProps<typeof TimeblockSearchContent>> = {},
  ) {
    const props = {
      query: 'work',
      results: [result],
      activitiesById: new Map([
        ['activity-work', { id: 'activity-work', name: 'Work', color: 'blue', icon: 'briefcase' }],
      ]),
      isLoading: false,
      isError: false,
      hasMore: false,
      locale: 'en',
      timezone: 'Asia/Tokyo',
      timeFormat: '24h' as const,
      onOpenResult: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    };

    const hasResultList =
      props.query.trim().length > 0 &&
      !props.isLoading &&
      !props.isError &&
      props.results.length > 0;
    render(
      <Command>
        {hasResultList ? (
          <CommandList>
            <TimeblockSearchContent {...props} />
          </CommandList>
        ) : (
          <div>
            <TimeblockSearchContent {...props} />
          </div>
        )}
      </Command>,
    );
    return props;
  }

  it('kind・アクティビティ・ノート・日時を表示し、IDは表示しない', () => {
    renderContent();

    expect(screen.getByText('calendar.search.kind.record')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Calendar search states')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.queryByText('record-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-icon')).toHaveAttribute('data-uncategorized', 'false');
  });

  it('アクティビティを解決できない結果はアクティビティなしを表示名にし、中立マーカーのActivityIconを描画する', () => {
    renderContent({
      results: [{ ...result, activityId: null }],
      activitiesById: new Map(),
    });

    expect(screen.getByText('calendar.filter.noActivity')).toBeInTheDocument();
    expect(screen.getByTestId('activity-icon')).toHaveAttribute('data-uncategorized', 'true');
  });

  it('エラー時に再試行できる', () => {
    const props = renderContent({ results: [], isError: true });

    fireEvent.click(screen.getByRole('button', { name: 'calendar.search.retry' }));

    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Calendar search states')).not.toBeInTheDocument();
  });

  it('検索中を表示する', () => {
    renderContent({ results: [], isLoading: true });
    expect(screen.getByRole('status')).toHaveTextContent('calendar.search.loading');
  });

  it('該当なしを表示する', () => {
    renderContent({ results: [] });
    expect(screen.getByRole('status')).toHaveTextContent('calendar.search.empty');
  });

  it('20件を超える場合の絞り込み案内を表示する', () => {
    renderContent({ hasMore: true });

    expect(screen.getByRole('note')).toHaveTextContent('calendar.search.overflow');
  });
});
