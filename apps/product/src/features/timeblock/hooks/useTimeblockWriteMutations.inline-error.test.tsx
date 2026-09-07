import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTimeblockWriteMutations } from './useTimeblockWriteMutations';

interface MutationCallbacks {
  retry?: boolean;
  onMutate?: (input: {
    id: string;
    data: {
      title?: string;
      note?: string | null;
      start_at?: string;
      end_at?: string;
      fulfillment?: 'low' | 'medium' | 'high' | null;
    };
  }) => Promise<unknown>;
  onSuccess?: (data: TimeModelRow) => void;
  onError?: (
    error: { message: string; data?: { serviceCode?: string } },
    input: { id: string; data: { start_at: string; end_at: string } } | undefined,
    context: undefined,
  ) => void;
}

interface TimeModelRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  skipped_at?: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

type CacheEntry = [queryKey: unknown, rows: TimeModelRow[]];

const mocks = vi.hoisted(() => ({
  planCreateCallbacks: undefined as MutationCallbacks | undefined,
  recordCreateCallbacks: undefined as MutationCallbacks | undefined,
  planUpdateCallbacks: undefined as MutationCallbacks | undefined,
  recordUpdateCallbacks: undefined as MutationCallbacks | undefined,
  planRestoreCallbacks: undefined as MutationCallbacks | undefined,
  planSkipCallbacks: undefined as MutationCallbacks | undefined,
  otherMutationCallbacks: [] as MutationCallbacks[],
  cacheEntries: [] as CacheEntry[],
  querySetData: vi.fn(),
  planDetailSetData: vi.fn(),
  planDetailInvalidate: vi.fn(),
  planDetailFetch: vi.fn().mockResolvedValue({ id: 'plan-1' }),
  recordDetailSetData: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    // snapshot 前の in-flight refetch を止める（#2567 で utils.*.cancel から
    // queryClient.cancelQueries へ移した。挙動は同じく list query だけを止める）
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    getQueriesData: vi.fn(({ predicate }) =>
      mocks.cacheEntries.filter(([queryKey]) => predicate({ queryKey })),
    ),
    setQueriesData: vi.fn(),
    setQueryData: mocks.querySetData.mockImplementation((queryKey, value) => {
      const entry = mocks.cacheEntries.find(([candidate]) => candidate === queryKey);
      if (!entry) return;
      entry[1] =
        typeof value === 'function'
          ? (value as (rows: TimeModelRow[]) => TimeModelRow[])(entry[1])
          : (value as TimeModelRow[]);
    }),
  }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock('@/lib/trpc', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  const useMutation = (callbacks: MutationCallbacks) => {
    mocks.otherMutationCallbacks.push(callbacks);
    return mutation();
  };

  return {
    api: {
      useUtils: () => ({
        plans: {
          invalidate: vi.fn(),
          list: { cancel: vi.fn() },
          getById: {
            fetch: mocks.planDetailFetch,
            invalidate: mocks.planDetailInvalidate,
            setData: mocks.planDetailSetData,
          },
        },
        records: {
          invalidate: vi.fn(),
          list: { cancel: vi.fn() },
          getById: { fetch: vi.fn(), invalidate: vi.fn(), setData: mocks.recordDetailSetData },
        },
      }),
      planCommands: {
        create: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.planCreateCallbacks = callbacks;
            return mutation();
          },
        },
        update: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.planUpdateCallbacks = callbacks;
            return mutation();
          },
        },
        delete: { useMutation },
        restore: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.planRestoreCallbacks = callbacks;
            return useMutation(callbacks);
          },
        },
        skip: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.planSkipCallbacks = callbacks;
            return useMutation(callbacks);
          },
        },
        unskip: { useMutation },
      },
      recordCommands: {
        create: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.recordCreateCallbacks = callbacks;
            return mutation();
          },
        },
        update: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.recordUpdateCallbacks = callbacks;
            return mutation();
          },
        },
        delete: { useMutation },
        restore: { useMutation },
      },
    },
  };
});

describe('useTimeblockWriteMutations create overlap presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planCreateCallbacks = undefined;
    mocks.recordCreateCallbacks = undefined;
    mocks.planUpdateCallbacks = undefined;
    mocks.recordUpdateCallbacks = undefined;
    mocks.planRestoreCallbacks = undefined;
    mocks.planSkipCallbacks = undefined;
    mocks.otherMutationCallbacks = [];
    mocks.cacheEntries = [];
    mocks.recordDetailSetData.mockClear();
  });

  it('全command mutationでglobal retry設定を上書きする', () => {
    renderHook(() => useTimeblockWriteMutations());

    const callbacks = [
      mocks.planCreateCallbacks,
      mocks.recordCreateCallbacks,
      mocks.planUpdateCallbacks,
      mocks.recordUpdateCallbacks,
      ...mocks.otherMutationCallbacks,
    ];
    expect(callbacks).toHaveLength(10);
    expect(callbacks.every((options) => options?.retry === false)).toBe(true);
  });

  it('Recordのfulfillment省略更新は楽観patchで既存値を保持する', async () => {
    renderHook(() => useTimeblockWriteMutations());

    await act(async () => {
      await mocks.recordUpdateCallbacks?.onMutate?.({
        id: 'record-1',
        data: { title: 'renamed only' },
      });
    });

    const updater = mocks.recordDetailSetData.mock.calls.at(-1)?.[1] as (
      old: { title: string; fulfillment: string | null } | undefined,
    ) => unknown;
    expect(updater({ title: 'old title', fulfillment: 'high' })).toMatchObject({
      title: 'renamed only',
      fulfillment: 'high',
    });
  });

  it('Recordのfulfillment明示null更新は楽観patchで解除する', async () => {
    renderHook(() => useTimeblockWriteMutations());

    await act(async () => {
      await mocks.recordUpdateCallbacks?.onMutate?.({
        id: 'record-1',
        data: { fulfillment: null },
      });
    });

    const updater = mocks.recordDetailSetData.mock.calls.at(-1)?.[1] as (
      old: { title: string; fulfillment: string | null } | undefined,
    ) => unknown;
    expect(updater({ title: 'unchanged', fulfillment: 'high' })).toMatchObject({
      title: 'unchanged',
      fulfillment: null,
    });
  });

  it('競合回復のdetail取得前にexact queryをstaleへする', async () => {
    const { result } = renderHook(() => useTimeblockWriteMutations());

    await result.current.fetchPlanById('plan-1');

    expect(mocks.planDetailInvalidate).toHaveBeenCalledWith({ id: 'plan-1' });
    expect(mocks.planDetailFetch).toHaveBeenCalledWith({ id: 'plan-1' });
    expect(mocks.planDetailInvalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.planDetailFetch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('inline handler指定時はPlanのTIME_OVERLAPをトーストにせず委譲する', () => {
    const onCreateTimeOverlap = vi.fn();
    renderHook(() => useTimeblockWriteMutations({ onCreateTimeOverlap }));

    act(() =>
      mocks.planCreateCallbacks?.onError?.(
        { message: 'TIME_OVERLAP: overlapping plan' },
        undefined,
        undefined,
      ),
    );

    expect(onCreateTimeOverlap).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('inline handler指定時はRecordのTIME_OVERLAPも同じ経路へ委譲する', () => {
    const onCreateTimeOverlap = vi.fn();
    renderHook(() => useTimeblockWriteMutations({ onCreateTimeOverlap }));

    act(() =>
      mocks.recordCreateCallbacks?.onError?.(
        { message: 'TIME_OVERLAP: overlapping record' },
        undefined,
        undefined,
      ),
    );

    expect(onCreateTimeOverlap).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('inline handler未指定時とその他のcreate失敗は従来どおりトーストへ送る', () => {
    renderHook(() => useTimeblockWriteMutations());

    act(() =>
      mocks.planCreateCallbacks?.onError?.(
        { message: 'TIME_OVERLAP: overlapping plan' },
        undefined,
        undefined,
      ),
    );
    expect(mocks.toastError).toHaveBeenLastCalledWith('toast.overlap');

    act(() => mocks.recordCreateCallbacks?.onError?.({ message: 'UNKNOWN' }, undefined, undefined));
    expect(mocks.toastError).toHaveBeenLastCalledWith('toast.saveFailed');
  });

  // server 拒否（DT003 / DT005）の文言は allowlist に載った serviceCode から引く。
  // ここが汎用 saveFailed に落ちると、UI 側の事前チェック（invariants.md §時刻 の
  // 分類 (b)）が「消せない写し」になる（#2628）。
  it('serverの時刻規則拒否は規則ごとの文言を出す', () => {
    renderHook(() => useTimeblockWriteMutations());

    act(() =>
      mocks.recordUpdateCallbacks?.onError?.(
        { message: 'record ends in the future', data: { serviceCode: 'RECORD_IN_FUTURE' } },
        undefined,
        undefined,
      ),
    );
    expect(mocks.toastError).toHaveBeenLastCalledWith('timeLocked');

    act(() =>
      mocks.planUpdateCallbacks?.onError?.(
        { message: 'end must be after start', data: { serviceCode: 'INVALID_TIME_RANGE' } },
        undefined,
        undefined,
      ),
    );
    expect(mocks.toastError).toHaveBeenLastCalledWith('duplicate.validation.invalidRange');

    act(() => mocks.planUpdateCallbacks?.onError?.({ message: 'UNKNOWN' }, undefined, undefined));
    expect(mocks.toastError).toHaveBeenLastCalledWith('toast.saveFailed');
  });

  it('updateのTIME_OVERLAPを入力付きでinline handlerへ委譲する', () => {
    const onUpdateTimeOverlap = vi.fn();
    renderHook(() => useTimeblockWriteMutations({ onUpdateTimeOverlap }));
    const input = {
      id: 'plan-1',
      data: {
        start_at: '2026-07-17T09:00:00.000Z',
        end_at: '2026-07-17T10:00:00.000Z',
      },
    };

    act(() =>
      mocks.planUpdateCallbacks?.onError?.(
        { message: 'TIME_OVERLAP: overlapping plan' },
        input,
        undefined,
      ),
    );

    expect(onUpdateTimeOverlap).toHaveBeenCalledWith(input);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('updateの通常エラーはinline handlerを使わずトーストへ送る', () => {
    const onUpdateTimeOverlap = vi.fn();
    renderHook(() => useTimeblockWriteMutations({ onUpdateTimeOverlap }));

    act(() =>
      mocks.recordUpdateCallbacks?.onError?.(
        { message: 'UNKNOWN' },
        {
          id: 'record-1',
          data: {
            start_at: '2026-07-17T09:00:00.000Z',
            end_at: '2026-07-17T10:00:00.000Z',
          },
        },
        undefined,
      ),
    );

    expect(onUpdateTimeOverlap).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenLastCalledWith('toast.saveFailed');
  });

  it('update commandの返却行とraw versionを一覧・詳細cacheの正本にする', () => {
    const queryKey = [['plans', 'list'], { input: {}, type: 'query' }];
    const current: TimeModelRow = {
      id: 'plan-1',
      title: 'Before',
      note: null,
      activity_id: null,
      start_at: '2026-07-17T09:00:00.000Z',
      end_at: '2026-07-17T10:00:00.000Z',
      skipped_at: null,
      deleted_at: null,
      created_at: '2026-07-17T08:00:00.000Z',
      updated_at: '2026-07-17T08:00:00.000001+00:00',
    };
    const updated = {
      ...current,
      title: 'After',
      updated_at: '2026-07-17T08:00:00.000002+00:00',
    };
    mocks.cacheEntries = [[queryKey, [current]]];
    renderHook(() => useTimeblockWriteMutations());

    act(() => mocks.planUpdateCallbacks?.onSuccess?.(updated));

    expect(mocks.cacheEntries[0]?.[1]).toEqual([updated]);
    expect(mocks.planDetailSetData).toHaveBeenCalledWith({ id: updated.id }, updated);
  });

  it('skip commandの返却行をincludeSkipped=falseの一覧から除く', () => {
    const queryKey = [['plans', 'list'], { input: { includeSkipped: false }, type: 'query' }];
    const current: TimeModelRow = {
      id: 'plan-1',
      title: 'Plan',
      note: null,
      activity_id: null,
      start_at: '2026-07-17T09:00:00.000Z',
      end_at: '2026-07-17T10:00:00.000Z',
      skipped_at: null,
      deleted_at: null,
      created_at: '2026-07-17T08:00:00.000Z',
      updated_at: '2026-07-17T08:00:00.000001+00:00',
    };
    mocks.cacheEntries = [[queryKey, [current]]];
    renderHook(() => useTimeblockWriteMutations());

    act(() =>
      mocks.planSkipCallbacks?.onSuccess?.({
        ...current,
        skipped_at: '2026-07-17T10:30:00.000Z',
        updated_at: '2026-07-17T10:30:00.000001+00:00',
      }),
    );

    expect(mocks.cacheEntries[0]?.[1]).toEqual([]);
  });

  it('restore commandの返却行を一致する一覧へ再挿入する', () => {
    const queryKey = [['plans', 'list'], { input: {}, type: 'query' }];
    const restored: TimeModelRow = {
      id: 'plan-1',
      title: 'Restored',
      note: null,
      activity_id: null,
      start_at: '2026-07-17T09:00:00.000Z',
      end_at: '2026-07-17T10:00:00.000Z',
      skipped_at: null,
      deleted_at: null,
      created_at: '2026-07-17T08:00:00.000Z',
      updated_at: '2026-07-17T11:00:00.000001+00:00',
    };
    mocks.cacheEntries = [[queryKey, []]];
    renderHook(() => useTimeblockWriteMutations());

    act(() => mocks.planRestoreCallbacks?.onSuccess?.(restored));

    expect(mocks.cacheEntries[0]?.[1]).toEqual([restored]);
    expect(mocks.planDetailSetData).toHaveBeenCalledWith({ id: restored.id }, restored);
  });
});
