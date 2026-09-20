import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SelectionInput = {
  connectionId: string;
  calendars: Array<{ providerCalendarId: string; calendarName?: string | null }>;
};

type SelectionContext = {
  previousProvider: typeof PREVIOUS_PROVIDER;
  previousStatus: typeof PREVIOUS_STATUS;
};

type UpdateMutationOptions = {
  onMutate: (input: SelectionInput) => Promise<SelectionContext>;
  onError: (error: unknown, input: SelectionInput, context?: SelectionContext) => void;
  onSettled: () => Promise<void>;
};

type SimpleMutationOptions = {
  onMutate?: () => Promise<void>;
  onSettled: () => Promise<void>;
};

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
const QUERY_INPUT = { connectionId: CONNECTION_ID };
const PREVIOUS_PROVIDER = [
  { id: 'primary', name: 'Primary', primary: true, selected: true },
  { id: 'focus', name: 'Focus', primary: false, selected: false },
];
const PREVIOUS_STATUS = {
  connection: {
    id: CONNECTION_ID,
    provider: 'google',
    provider_account_email: 'user@example.com',
    status: 'active',
    last_synced_at: null,
    last_sync_error: null,
  },
  calendars: [{ provider_calendar_id: 'primary', calendar_name: 'Primary', last_synced_at: null }],
};

const mocks = vi.hoisted(() => ({
  updateOptions: null as UpdateMutationOptions | null,
  syncOptions: null as SimpleMutationOptions | null,
  disconnectOptions: null as SimpleMutationOptions | null,
  updateMutate: vi.fn(),
  syncMutate: vi.fn(),
  disconnectMutate: vi.fn(),
  disconnectMutateAsync: vi.fn(),
  listCancel: vi.fn(),
  listInvalidate: vi.fn(),
  listSetData: vi.fn(),
  providerCancel: vi.fn(),
  providerGetData: vi.fn(),
  providerSetData: vi.fn(),
  providerInvalidate: vi.fn(),
  statusCancel: vi.fn(),
  statusGetData: vi.fn(),
  statusSetData: vi.fn(),
  statusInvalidate: vi.fn(),
  listEventsInvalidate: vi.fn(),
  providerQueryOptions: null as { enabled?: boolean } | null,
  canUseProduct: true,
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/billing/BillingAccessProvider', () => ({
  useBillingAccess: () => ({
    state: mocks.canUseProduct ? 'trial' : 'expired',
    canUseProduct: mocks.canUseProduct,
    trialEndsAt: null,
    enforced: true,
  }),
}));

vi.mock('@/lib/hooks/useHasMounted', () => ({
  useHasMounted: () => true,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({
      externalCalendar: {
        listConnections: {
          cancel: mocks.listCancel,
          invalidate: mocks.listInvalidate,
          setData: mocks.listSetData,
        },
        listProviderCalendars: {
          cancel: mocks.providerCancel,
          getData: mocks.providerGetData,
          setData: mocks.providerSetData,
          invalidate: mocks.providerInvalidate,
        },
        getSyncStatus: {
          cancel: mocks.statusCancel,
          getData: mocks.statusGetData,
          setData: mocks.statusSetData,
          invalidate: mocks.statusInvalidate,
        },
        listEvents: {
          invalidate: mocks.listEventsInvalidate,
        },
      },
    }),
    externalCalendar: {
      listConnections: {
        useQuery: () => ({
          data: [PREVIOUS_STATUS.connection],
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      getConnectionAvailability: {
        useQuery: () => ({ data: { available: true }, isLoading: false }),
      },
      getSyncStatus: {
        useQuery: () => ({ data: PREVIOUS_STATUS, isError: false, refetch: vi.fn() }),
      },
      listProviderCalendars: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => ({
          ...((mocks.providerQueryOptions = options), {}),
          data: PREVIOUS_PROVIDER,
          error: null,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      updateSelectedCalendars: {
        useMutation: (options: UpdateMutationOptions) => {
          mocks.updateOptions = options;
          return { mutate: mocks.updateMutate, isPending: false };
        },
      },
      syncNow: {
        useMutation: (options: SimpleMutationOptions) => {
          mocks.syncOptions = options;
          return { mutate: mocks.syncMutate, isPending: false };
        },
      },
      disconnect: {
        useMutation: (options: SimpleMutationOptions) => {
          mocks.disconnectOptions = options;
          return {
            mutate: mocks.disconnectMutate,
            mutateAsync: mocks.disconnectMutateAsync,
            isPending: false,
          };
        },
      },
    },
  },
}));

import { GoogleCalendarSettings } from './GoogleCalendarSettings';

describe('GoogleCalendarSettings mutation contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateOptions = null;
    mocks.syncOptions = null;
    mocks.disconnectOptions = null;
    mocks.providerQueryOptions = null;
    mocks.canUseProduct = true;
    mocks.providerGetData.mockReturnValue(PREVIOUS_PROVIDER);
    mocks.statusGetData.mockReturnValue(PREVIOUS_STATUS);
    for (const invalidate of [
      mocks.listInvalidate,
      mocks.providerInvalidate,
      mocks.statusInvalidate,
      mocks.listEventsInvalidate,
    ]) {
      invalidate.mockResolvedValue(undefined);
    }
    mocks.listCancel.mockResolvedValue(undefined);
    mocks.providerCancel.mockResolvedValue(undefined);
    mocks.statusCancel.mockResolvedValue(undefined);
  });

  it('選択更新を snapshot し、失敗時に rollback して settled で authoritative refetch する', async () => {
    render(<GoogleCalendarSettings />);
    const input: SelectionInput = {
      connectionId: CONNECTION_ID,
      calendars: [{ providerCalendarId: 'focus', calendarName: 'Focus' }],
    };

    let context: SelectionContext | undefined;
    await act(async () => {
      context = await mocks.updateOptions?.onMutate(input);
    });

    expect(mocks.providerCancel).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.statusCancel).toHaveBeenCalledWith(QUERY_INPUT);
    expect(context).toEqual({
      previousProvider: PREVIOUS_PROVIDER,
      previousStatus: PREVIOUS_STATUS,
    });

    const providerUpdater = mocks.providerSetData.mock.calls[0]?.[1] as (
      current: typeof PREVIOUS_PROVIDER,
    ) => typeof PREVIOUS_PROVIDER;
    expect(providerUpdater(PREVIOUS_PROVIDER).map((calendar) => calendar.selected)).toEqual([
      false,
      true,
    ]);

    act(() => {
      mocks.updateOptions?.onError(new Error('failed'), input, context);
    });
    expect(mocks.providerSetData).toHaveBeenNthCalledWith(2, QUERY_INPUT, PREVIOUS_PROVIDER);
    expect(mocks.statusSetData).toHaveBeenNthCalledWith(2, QUERY_INPUT, PREVIOUS_STATUS);

    await act(async () => {
      await mocks.updateOptions?.onSettled();
    });
    expect(mocks.listInvalidate).toHaveBeenCalledOnce();
    expect(mocks.providerInvalidate).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.statusInvalidate).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.listEventsInvalidate).toHaveBeenCalledOnce();
  });

  it('手動同期は settled 後に connection と sync status を再取得する', async () => {
    render(<GoogleCalendarSettings />);

    await act(async () => {
      await mocks.syncOptions?.onSettled();
    });

    expect(mocks.listInvalidate).toHaveBeenCalledOnce();
    expect(mocks.statusInvalidate).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.listEventsInvalidate).toHaveBeenCalledOnce();
  });

  it('利用権が無い時は server が拒否する呼び出し（一覧取得・選択更新・手動同期）を送らない', () => {
    // server は listProviderCalendars / updateSelectedCalendars / syncNow を
    // BILLING_ACCESS_ENDED で拒否する（lib/billing/operation-access.ts）。UI 側で止めないと
    // 「同期に失敗しました」の汎用 toast だけが残り、障害と区別できない。切断は server も
    // 許すので残す。
    mocks.canUseProduct = false;
    render(<GoogleCalendarSettings />);

    expect(mocks.providerQueryOptions?.enabled).toBe(false);
    expect(screen.getByRole('button', { name: 'syncNow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'disconnect' })).toBeEnabled();
    expect(screen.getByText('dataControls.mcp.proRequired')).toBeInTheDocument();
  });

  it('切断は一覧を楽観削除せず、settled 後に全関連 query を再取得する', async () => {
    render(<GoogleCalendarSettings />);

    await act(async () => {
      await mocks.disconnectOptions?.onMutate?.();
    });
    expect(mocks.listCancel).toHaveBeenCalledOnce();
    expect(mocks.listSetData).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.disconnectOptions?.onSettled();
    });
    expect(mocks.listInvalidate).toHaveBeenCalledOnce();
    expect(mocks.providerInvalidate).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.statusInvalidate).toHaveBeenCalledWith(QUERY_INPUT);
    expect(mocks.listEventsInvalidate).toHaveBeenCalledOnce();
  });
});
