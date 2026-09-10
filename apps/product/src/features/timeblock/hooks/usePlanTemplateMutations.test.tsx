/**
 * テンプレート適用の楽観的更新（#2567）。
 *
 * 見たいのは「onMutate で何が cache に入り、onSuccess / onError で何が残るか」なので、
 * mutation は callbacks を捕まえるだけの mock にして、cache 操作の結果を assert する
 * （`useTimeblockWriteMutations.inline-error.test.tsx` と同じ形）。
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlanRow = {
  id: string;
  title: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  deleted_at: string | null;
  [key: string]: unknown;
};

interface MutationCallbacks {
  onMutate?: (input: unknown) => Promise<unknown> | unknown;
  onSuccess?: (data: unknown, input: unknown, context: unknown) => void;
  onError?: (error: unknown, input: unknown, context: unknown) => void;
  onSettled?: () => void;
}

const PLANS_LIST_KEY = [['plans', 'list'], { type: 'query' }];

const mocks = vi.hoisted(() => ({
  /** plans.list cache の中身（1 query 分） */
  planRows: [] as unknown[],
  applyCallbacks: null as MutationCallbacks | null,
  renameCallbacks: null as MutationCallbacks | null,
  templateListData: [] as unknown[],
  templateListSetData: vi.fn(),
  templateListCancel: vi.fn(),
  plansInvalidate: vi.fn(),
  templateListInvalidate: vi.fn(),
  cancelQueries: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  deletePlanMutate: vi.fn(),
}));

/**
 * 適用の取り消しは `useTimeblockWriteMutations` の削除経路を借りる。ここで見たいのは
 * 「返ってきた行それぞれに削除を投げるか」なので、mutation 群は差し替え、同じ module が
 * 提供する pure helper（snapshot / insert 等）は本物を使う。
 */
vi.mock('./useTimeblockWriteMutations', async () => {
  const actual = await vi.importActual<typeof import('./useTimeblockWriteMutations')>(
    './useTimeblockWriteMutations',
  );
  return {
    ...actual,
    useTimeblockWriteMutations: () => ({ deletePlan: { mutate: mocks.deletePlanMutate } }),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    cancelQueries: mocks.cancelQueries.mockResolvedValue(undefined),
    getQueriesData: vi.fn(({ predicate }: { predicate: (q: { queryKey: unknown }) => boolean }) =>
      predicate({ queryKey: PLANS_LIST_KEY }) ? [[PLANS_LIST_KEY, [...mocks.planRows]]] : [],
    ),
    setQueryData: vi.fn((_key: unknown, value: unknown) => {
      mocks.planRows =
        (typeof value === 'function'
          ? (value as (rows: unknown[]) => unknown[])([...mocks.planRows])
          : (value as unknown[])) ?? [];
    }),
    setQueriesData: vi.fn(
      (
        { predicate }: { predicate: (q: { queryKey: unknown }) => boolean },
        updater: (rows: unknown[]) => unknown[],
      ) => {
        if (!predicate({ queryKey: PLANS_LIST_KEY })) return;
        mocks.planRows = updater([...mocks.planRows]) ?? [];
      },
    ),
  }),
}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (
    selector: (preferences: { timezone: string; defaultDuration: number }) => unknown,
  ) => selector({ timezone: 'Asia/Tokyo', defaultDuration: 60 }),
}));

vi.mock('@/lib/trpc', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    api: {
      useUtils: () => ({
        plans: { invalidate: mocks.plansInvalidate },
        planTemplates: {
          list: {
            cancel: mocks.templateListCancel,
            getData: () => mocks.templateListData,
            setData: mocks.templateListSetData,
            invalidate: mocks.templateListInvalidate,
          },
        },
      }),
      planTemplates: {
        applyToDay: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.applyCallbacks = callbacks;
            return mutation();
          },
        },
        create: { useMutation: () => mutation() },
        rename: {
          useMutation: (callbacks: MutationCallbacks) => {
            mocks.renameCallbacks = callbacks;
            return mutation();
          },
        },
        delete: { useMutation: () => mutation() },
      },
    },
  };
});

import { usePlanTemplateMutations } from './usePlanTemplateMutations';

const TEMPLATE_ID = 'template-1';
const ACTIVITY_ID = '00000000-0000-4000-8000-0000000000b1';

const template = {
  id: TEMPLATE_ID,
  name: '朝のルーティン',
  blocks: [
    {
      id: 'block-1',
      activityId: ACTIVITY_ID,
      title: '集中',
      anchorMinute: 9 * 60,
      previewDurationMinutes: 90,
    },
    {
      id: 'block-2',
      activityId: null,
      title: '昼',
      anchorMinute: 12 * 60,
      previewDurationMinutes: 30,
    },
  ],
};

function planRow(overrides: Partial<PlanRow>): PlanRow {
  return {
    id: 'existing',
    title: '既存',
    activity_id: null,
    start_at: '2026-09-05T20:00:00.000Z',
    end_at: '2026-09-05T21:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('usePlanTemplateMutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planRows = [planRow({})];
    mocks.templateListData = [template];
    mocks.applyCallbacks = null;
    mocks.renameCallbacks = null;
    renderHook(() => usePlanTemplateMutations());
  });

  describe('applyToDay の楽観的更新', () => {
    it('list のプレビュー長のまま temp 行を plans cache へ置く', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });

      const inserted = (mocks.planRows as PlanRow[]).filter((row) => row.id.startsWith('temp-'));
      expect(inserted).toEqual([
        expect.objectContaining({
          id: `temp-${TEMPLATE_ID}-block-1`,
          title: '集中',
          activity_id: ACTIVITY_ID,
          start_at: '2026-09-05T00:00:00.000Z', // 09:00 JST
          end_at: '2026-09-05T01:30:00.000Z', // プレビュー 90 分
        }),
        expect.objectContaining({
          id: `temp-${TEMPLATE_ID}-block-2`,
          title: '昼',
          activity_id: null,
          start_at: '2026-09-05T03:00:00.000Z',
          end_at: '2026-09-05T03:30:00.000Z',
        }),
      ]);
      expect((context as { tempIds: Set<string> }).tempIds.size).toBe(2);
      expect(mocks.cancelQueries).toHaveBeenCalled();
    });

    it('成功時に temp 行を server 行へ入れ替える（temp が残らない）', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });
      const serverRows = [
        planRow({
          id: 'plan-1',
          title: '集中',
          start_at: '2026-09-05T00:00:00.000Z',
          end_at: '2026-09-05T01:00:00.000Z',
        }),
      ];

      mocks.applyCallbacks?.onSuccess?.(serverRows, {}, context);

      const ids = (mocks.planRows as PlanRow[]).map((row) => row.id).sort();
      expect(ids).toEqual(['existing', 'plan-1']);
    });

    it('成功時は置いた件数と取り消しを出し、取り消しで全件削除する', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });
      const serverRows = [
        planRow({
          id: 'plan-1',
          title: '集中',
          start_at: '2026-09-05T00:00:00.000Z',
          end_at: '2026-09-05T01:00:00.000Z',
          updated_at: '2026-09-05T00:00:00.000Z',
        }),
        planRow({
          id: 'plan-2',
          title: '休憩',
          start_at: '2026-09-05T01:00:00.000Z',
          end_at: '2026-09-05T01:30:00.000Z',
          updated_at: '2026-09-05T00:00:00.000Z',
        }),
      ];

      mocks.applyCallbacks?.onSuccess?.(serverRows, {}, context);

      const [message, options] = mocks.toastSuccess.mock.calls[0] as [
        string,
        { action: { onClick: () => void } },
      ];
      expect(message).toBe('calendar.templates.toast.applied');

      // 1 タップで増えた分は 1 タップで戻せる
      options.action.onClick();
      expect(mocks.deletePlanMutate).toHaveBeenCalledTimes(2);
      expect(
        mocks.deletePlanMutate.mock.calls.map(([input]) => (input as { id: string }).id),
      ).toEqual(['plan-1', 'plan-2']);
    });

    it('1 件も置かなかった時は取り消しを出さない', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });

      mocks.applyCallbacks?.onSuccess?.([], {}, context);

      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('失敗時は temp 行を全て巻き戻し、重複は専用の文言で伝える', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });
      expect((mocks.planRows as PlanRow[]).length).toBe(3);

      mocks.applyCallbacks?.onError?.(
        { message: 'TIME_OVERLAP', data: { serviceCode: 'TIME_OVERLAP' } },
        {},
        context,
      );

      expect((mocks.planRows as PlanRow[]).map((row) => row.id)).toEqual(['existing']);
      expect(mocks.toastError).toHaveBeenCalledWith('calendar.templates.toast.applyOverlap');
    });

    it('この日に収まらない型は原因が分かる文言で伝える', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });

      mocks.applyCallbacks?.onError?.(
        { message: 'does not fit', data: { serviceCode: 'TEMPLATE_DOES_NOT_FIT' } },
        {},
        context,
      );

      expect(mocks.toastError).toHaveBeenCalledWith('calendar.templates.toast.applyDoesNotFit');
    });

    it('重複以外の失敗は汎用の文言で伝える', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });

      mocks.applyCallbacks?.onError?.({ message: 'BOOM' }, {}, context);

      expect(mocks.toastError).toHaveBeenCalledWith('calendar.templates.toast.applyFailed');
    });

    it('cache に無い型は楽観行を置かない（server の応答を待つ）', async () => {
      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: 'unknown',
        date: '2026-09-05',
      });

      expect((mocks.planRows as PlanRow[]).map((row) => row.id)).toEqual(['existing']);
      expect((context as { tempIds: Set<string> }).tempIds.size).toBe(0);
    });

    it('具現化できない型（間隔が 5 分未満）は楽観行を置かない', async () => {
      mocks.templateListData = [
        {
          ...template,
          blocks: [
            { ...template.blocks[0], anchorMinute: 540 },
            { ...template.blocks[1], anchorMinute: 542 },
          ],
        },
      ];

      const context = await mocks.applyCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        date: '2026-09-05',
      });

      expect((mocks.planRows as PlanRow[]).map((row) => row.id)).toEqual(['existing']);
      expect((context as { tempIds: Set<string> }).tempIds.size).toBe(0);
    });
  });

  describe('rename の楽観的更新', () => {
    it('onMutate で名前を差し替え、失敗したら元に戻す', async () => {
      const context = await mocks.renameCallbacks?.onMutate?.({
        templateId: TEMPLATE_ID,
        name: '新しい名前',
      });

      const updater = mocks.templateListSetData.mock.calls[0]?.[1] as (
        old: typeof mocks.templateListData,
      ) => Array<{ id: string; name: string }>;
      expect(updater([template]).map((item) => item.name)).toEqual(['新しい名前']);

      mocks.renameCallbacks?.onError?.({ message: 'BOOM' }, {}, context);
      expect(mocks.templateListSetData).toHaveBeenLastCalledWith(undefined, [template]);
      expect(mocks.toastError).toHaveBeenCalledWith('calendar.templates.toast.renameFailed');
    });
  });
});
