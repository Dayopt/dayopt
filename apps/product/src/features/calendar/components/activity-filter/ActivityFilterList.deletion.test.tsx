import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statsState = vi.hoisted(() => ({
  data: undefined as
    { counts: Record<string, number>; planCounts: Record<string, number> } | undefined,
  isError: false,
}));
const empty = vi.hoisted(() => []);
const remove = vi.hoisted(() => vi.fn());
const notifyFailure = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({
  categories: [
    { category: { id: 'category-1', name: 'Category', color: 'blue', icon: null }, activities: [] },
  ],
  uncategorized: [{ id: 'activity-1', name: 'Activity', color: 'blue', category_id: null }],
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/features/activities', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  const { ActivityDeleteConfirmDialog } =
    await import('@/features/activities/components/ActivityDeleteConfirmDialog');
  const useDelete = () => useMutation({ mutationFn: remove, onError: notifyFailure, retry: false });
  return {
    ActivityDeleteConfirmDialog,
    useActivityTree: () => ({ data: fixture, isLoading: false, isFetching: false }),
    useArchivedActivities: () => ({ data: empty, isFetching: false }),
    useArchivedCategories: () => ({ data: empty }),
    collectActivitiesFromTree: () => fixture.uncategorized,
    collectActivityIdsFromTree: () => ['activity-1'],
    useDeleteActivity: useDelete,
    useDeleteCategory: useDelete,
    useArchiveActivity: () => ({ mutate: vi.fn() }),
    useArchiveCategory: () => ({ mutate: vi.fn() }),
  };
});
vi.mock('@/lib/trpc', () => ({
  api: { statistics: { getActivityStats: { useQuery: () => statsState } } },
}));
vi.mock('@/lib/billing/useProductAccessGate', () => ({
  useProductAccessGate: () => (action: () => void) => action(),
}));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useActivityModalNavigation', () => ({
  useActivityModalNavigation: () => ({ openActivityCreateModal: vi.fn() }),
}));
vi.mock('@/components/shell/sidebar', () => ({
  SidebarSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./ActivityDragContext', () => ({
  ActivityDragProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./components/UncategorizedDropZone', () => ({
  UncategorizedDropZone: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./components/CategoryCreateDialog', () => ({ CategoryCreateDialog: () => null }));
vi.mock('./components/ArchivedActivityList', () => ({ ArchivedActivityList: () => null }));
vi.mock('./components/CategoryGroup', () => ({
  CategoryGroup: ({
    onDeleteCategory,
  }: {
    onDeleteCategory: (id: string, name: string) => void;
  }) => <button onClick={() => onDeleteCategory('category-1', 'Category')}>delete category</button>,
}));
vi.mock('./components/ActivityRow', () => ({
  ActivityRow: ({ onDeleteActivity }: { onDeleteActivity: () => void }) => (
    <button onClick={onDeleteActivity}>delete activity</button>
  ),
}));

import { ActivityFilterList } from './ActivityFilterList';

describe('ActivityFilterList deletion failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statsState.data = undefined;
    statsState.isError = false;
  });
  it.each([
    ['loading', undefined, false, 'delete.activityDescriptionUnknown'],
    ['error', undefined, true, 'delete.activityDescriptionUnknown'],
    ['zero', { counts: {}, planCounts: {} }, false, 'delete.activityDescriptionEmpty'],
    [
      'known',
      { counts: { 'activity-1': 2 }, planCounts: { 'activity-1': 3 } },
      false,
      'delete.activityDescription',
    ],
  ] as const)(
    '%s count keeps confirmation without guessing',
    async (_state, data, isError, description) => {
      statsState.data = data;
      statsState.isError = isError;
      const client = new QueryClient();
      const view = render(
        <QueryClientProvider client={client}>
          <ActivityFilterList />
        </QueryClientProvider>,
      );
      try {
        await userEvent.click(screen.getByRole('button', { name: 'delete activity' }));
        expect(within(screen.getByRole('alertdialog')).getByText(description)).toBeInTheDocument();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        client.clear();
      }
    },
  );
  it.each(['activity', 'category'])(
    '%sの失敗は既存通知に任せ、未処理rejectなしで再操作できる',
    async (kind) => {
      remove
        .mockRejectedValueOnce(new Error('synthetic delete failure'))
        .mockResolvedValue({ id: `${kind}-1` });
      const client = new QueryClient();
      const user = userEvent.setup();
      const view = render(
        <QueryClientProvider client={client}>
          <ActivityFilterList />
        </QueryClientProvider>,
      );
      try {
        await user.click(screen.getByRole('button', { name: `delete ${kind}` }));
        await user.click(
          within(screen.getByRole('alertdialog')).getByRole('button', {
            name: 'delete.confirmButton',
          }),
        );
        await waitFor(() => expect(notifyFailure).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(remove.mock.calls[0]?.[0]).toEqual({ id: `${kind}-1` });
        await user.click(screen.getByRole('button', { name: `delete ${kind}` }));
        await user.click(
          within(screen.getByRole('alertdialog')).getByRole('button', {
            name: 'delete.confirmButton',
          }),
        );
        await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(notifyFailure).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        client.clear();
      }
    },
  );
});
