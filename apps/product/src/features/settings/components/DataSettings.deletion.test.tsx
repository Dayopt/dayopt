import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteBlocks = vi.hoisted(() => vi.fn());
const deleteAll = vi.hoisted(() => vi.fn());
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    api: {
      useUtils: () => ({ userSettings: { getAnalyticsConsent: { setData: vi.fn() } } }),
      userSettings: {
        get: { useQuery: () => ({ data: 'UTC' }) },
        getAnalyticsConsent: { useQuery: () => ({ data: { allowed: false } }) },
        setAnalyticsConsent: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      },
      user: {
        exportData: { useQuery: () => ({ refetch: vi.fn() }) },
        deleteBlocks: {
          useMutation: (options: object) =>
            useMutation({ ...options, mutationFn: deleteBlocks, retry: false }),
        },
        deleteAllData: {
          useMutation: (options: object) =>
            useMutation({ ...options, mutationFn: deleteAll, retry: false }),
        },
      },
      billing: { getOverview: { useQuery: () => ({ data: null, isLoading: false }) } },
    },
  };
});

import { toast } from '@/lib/toast';
import { DataSettings } from './DataSettings';

describe('DataSettings deletion failures', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['deleteBlocks', deleteBlocks, 'blocksDeleteFailed', 'blocksDeleted'],
    ['deleteAllData', deleteAll, 'allDataDeleteFailed', 'allDataDeleted'],
  ] as const)(
    '%sは失敗通知後も再試行でき、未処理rejectを残さない',
    async (button, mutation, failure, success) => {
      mutation
        .mockRejectedValueOnce(new Error('synthetic deletion failure'))
        .mockResolvedValue({ deletedCount: 2, success: true });
      const client = new QueryClient();
      const user = userEvent.setup();
      const view = render(
        <QueryClientProvider client={client}>
          <DataSettings />
        </QueryClientProvider>,
      );
      try {
        await user.click(screen.getByRole('button', { name: button }));
        const dialog = screen.getByRole('alertdialog');
        const confirm = within(dialog).getByRole('button', { name: 'common.actions.delete' });
        expect(confirm).toBeDisabled();
        await user.type(within(dialog).getByRole('textbox'), 'confirmKeyword');
        await user.click(confirm);
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(confirm).toBeEnabled());
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(mutation.mock.calls[0]?.[0]).toEqual({ confirmText: 'DELETE' });
        expect(toast.success).not.toHaveBeenCalled();
        await user.click(confirm);
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(mutation).toHaveBeenCalledTimes(2);
        expect(toast.success).toHaveBeenCalledWith(success);
        expect(toast.error).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        client.clear();
      }
    },
  );
});
