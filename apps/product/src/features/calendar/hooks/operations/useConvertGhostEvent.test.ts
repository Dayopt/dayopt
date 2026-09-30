import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalCalendarEvent } from '@/features/external-calendar';

const createPlanMutate = vi.fn();
const createRecordMutate = vi.fn();
const deletePlanMutateAsync = vi.fn();
const deleteRecordMutateAsync = vi.fn();
const dismissEventMutateAsync = vi.fn();
const setQueriesData = vi.fn();
const listEventsInvalidate = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/features/timeblock', () => ({
  useTimeblockWriteMutations: () => ({
    createPlan: { mutate: createPlanMutate, isPending: false },
    createRecord: { mutate: createRecordMutate, isPending: false },
    deletePlan: { mutateAsync: deletePlanMutateAsync },
    deleteRecord: { mutateAsync: deleteRecordMutateAsync },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueriesData }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (msg: string, opts?: unknown) => toastSuccess(msg, opts),
    error: (msg: string) => toastError(msg),
  },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({
      externalCalendar: { listEvents: { invalidate: listEventsInvalidate } },
    }),
    externalCalendar: {
      dismissEvent: {
        useMutation: () => ({ mutateAsync: dismissEventMutateAsync, isPending: false }),
      },
    },
  },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const { useConvertGhostEvent } = await import('./useConvertGhostEvent');

const FUTURE_EVENT: ExternalCalendarEvent = {
  id: 'ghost-future',
  title: 'Future sync',
  calendarName: 'Work',
  startDate: new Date(Date.now() + 60 * 60_000),
  endDate: new Date(Date.now() + 2 * 60 * 60_000),
};

const PAST_EVENT: ExternalCalendarEvent = {
  id: 'ghost-past',
  title: 'Past sync',
  calendarName: 'Work',
  startDate: new Date(Date.now() - 2 * 60 * 60_000),
  endDate: new Date(Date.now() - 60 * 60_000),
};

beforeEach(() => {
  vi.clearAllMocks();
  deletePlanMutateAsync.mockResolvedValue(undefined);
  deleteRecordMutateAsync.mockResolvedValue(undefined);
});

/** `vi.fn().mock.calls[0]` は `noUncheckedIndexedAccess` で `undefined` を許すため、fallback を集約する。 */
function lastCallArgs(fn: { mock: { calls: unknown[][] } }): unknown[] {
  return fn.mock.calls.at(-1) ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConvertGhostEvent — convertGhost', () => {
  it('end_at が未来なら createPlan を呼ぶ', () => {
    const { result } = renderHook(() => useConvertGhostEvent());

    result.current.convertGhost(FUTURE_EVENT);

    expect(createPlanMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Future sync',
        externalCalendarEventId: 'ghost-future',
        start_at: FUTURE_EVENT.startDate.toISOString(),
        end_at: FUTURE_EVENT.endDate.toISOString(),
      }),
      expect.anything(),
    );
    expect(createRecordMutate).not.toHaveBeenCalled();
  });

  it('end_at が過去なら createRecord を呼ぶ', () => {
    const { result } = renderHook(() => useConvertGhostEvent());

    result.current.convertGhost(PAST_EVENT);

    expect(createRecordMutate).toHaveBeenCalledWith(
      expect.objectContaining({ externalCalendarEventId: 'ghost-past' }),
      expect.anything(),
    );
    expect(createPlanMutate).not.toHaveBeenCalled();
  });

  it('タイトル未設定なら untitled 訳を使う', () => {
    const { result } = renderHook(() => useConvertGhostEvent());

    result.current.convertGhost({ ...FUTURE_EVENT, title: null });

    expect(createPlanMutate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'calendar.external.untitled' }),
      expect.anything(),
    );
  });

  it('呼び出し時に ghost 一覧キャッシュから即時除去する（optimistic）', () => {
    const { result } = renderHook(() => useConvertGhostEvent());

    result.current.convertGhost(FUTURE_EVENT);

    expect(setQueriesData).toHaveBeenCalledWith(
      { predicate: expect.any(Function) },
      expect.any(Function),
    );
    const [, updater] = lastCallArgs(setQueriesData) as [unknown, (rows: unknown[]) => unknown[]];
    expect(updater([{ id: 'ghost-future' }, { id: 'other' }])).toEqual([{ id: 'other' }]);
  });

  it('成功時、undo action 付き toast を出す。undo は作成された行を削除する', () => {
    const { result } = renderHook(() => useConvertGhostEvent());
    result.current.convertGhost(FUTURE_EVENT);

    const [, options] = lastCallArgs(createPlanMutate) as [
      unknown,
      { onSuccess: (row: { id: string; updated_at: string }) => void },
    ];
    const created = { id: 'plan-1', updated_at: '2026-08-13T00:00:00.000Z' };
    options.onSuccess(created);

    expect(toastSuccess).toHaveBeenCalledWith(
      'calendar.external.toast.convertedToPlan',
      expect.objectContaining({ action: expect.objectContaining({ label: 'common.undo' }) }),
    );

    const [, toastOpts] = lastCallArgs(toastSuccess) as [
      unknown,
      { action: { onClick: () => void } },
    ];
    toastOpts.action.onClick();

    expect(deletePlanMutateAsync).toHaveBeenCalledWith({
      id: 'plan-1',
      expectedUpdatedAt: '2026-08-13T00:00:00.000Z',
    });
  });

  it.each([FUTURE_EVENT, PAST_EVENT])(
    '変換失敗時はghostを再取得し、共有mutationの通知を重ねない（$id）',
    (event) => {
      const { result } = renderHook(() => useConvertGhostEvent());
      result.current.convertGhost(event);

      const mutation = event === FUTURE_EVENT ? createPlanMutate : createRecordMutate;
      const [, options] = lastCallArgs(mutation) as [unknown, { onError: () => void }];
      options.onError();

      expect(listEventsInvalidate).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
    },
  );
});

describe('useConvertGhostEvent — dismissGhost', () => {
  it('dismissed:true で mutateAsync を呼び、キャッシュから即時除去する', async () => {
    dismissEventMutateAsync.mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useConvertGhostEvent());

    await result.current.dismissGhost(FUTURE_EVENT);

    expect(setQueriesData).toHaveBeenCalled();
    expect(dismissEventMutateAsync).toHaveBeenCalledWith({
      eventId: 'ghost-future',
      dismissed: true,
    });
  });

  it('失敗時、ghost 一覧を invalidate してエラー toast を出す', async () => {
    dismissEventMutateAsync.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useConvertGhostEvent());

    await result.current.dismissGhost(FUTURE_EVENT);

    expect(listEventsInvalidate).toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('calendar.external.toast.dismissFailed');
  });
});
