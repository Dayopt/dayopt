import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refetchExport = vi.hoisted(() => vi.fn());
const createObjectURL = vi.hoisted(() => vi.fn());
const revokeObjectURL = vi.hoisted(() => vi.fn());

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({ userSettings: { getAnalyticsConsent: { setData: vi.fn() } } }),
    userSettings: {
      getAnalyticsConsent: {
        useQuery: () => ({ data: { allowed: false }, isLoading: false, isError: false }),
      },
      setAnalyticsConsent: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    },
    user: {
      exportData: {
        useQuery: () => ({ refetch: refetchExport, isLoading: false, isFetching: false }),
      },
      deleteBlocks: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      deleteAllData: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    billing: {
      getOverview: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
  },
}));

import { DataSettings } from './DataSettings';

describe('DataSettings CSV export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refetchExport.mockResolvedValue({
      data: {
        data: {
          plans: [
            {
              id: 'plan-1',
              title: '=HYPERLINK("https://example.com")',
              note: '+1+1',
              start_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          records: [
            {
              id: 'record-1',
              title: 'Completed',
              note: '@SUM(A1:A2)',
              start_at: '2026-08-01T01:00:00.000Z',
            },
          ],
        },
      },
    });
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL.mockReturnValue('blob:dayopt-export'),
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('exportData の plan / record を安全な CSV Blob としてダウンロードする', async () => {
    const user = userEvent.setup();
    render(<DataSettings />);

    const formatSelect = screen.getAllByRole('combobox')[0];
    if (!formatSelect) throw new Error('format select not found');
    await user.click(formatSelect);
    await user.click(await screen.findByRole('option', { name: 'formatCsv' }));
    await user.click(screen.getByRole('button', { name: 'exportButton' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');

    const csv = await blob.text();
    expect(csv).toContain('plan,plan-1,"\'=HYPERLINK(""https://example.com"")",\'+1+1');
    expect(csv).toContain("record,record-1,Completed,'@SUM(A1:A2)");
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:dayopt-export');
  });
});
