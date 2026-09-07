/**
 * サイドバー / チップ行のタップからの即作成。
 *
 * 「タップした時点で保存され、作ったブロックが詳細パネルで開く」ことと、
 * 保存先が end_at のルールで決まることを確認する。
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActivityQuickCreate } from './useActivityQuickCreate';

const hasConflict = vi.hoisted(() => ({ value: false }));
const createPlanMutate = vi.hoisted(() => vi.fn());
const createRecordMutate = vi.hoisted(() => vi.fn());
const openInspector = vi.hoisted(() => vi.fn());

vi.mock('@/features/timeblock', async () => {
  const domain = await vi.importActual<
    typeof import('@/features/timeblock/domain/timeblock-destination')
  >('@/features/timeblock/domain/timeblock-destination');

  return {
    resolveTimeblockDestination: domain.resolveTimeblockDestination,
    collectTimeblockLaneItems: () => [],
    hasTimeblockLaneConflict: () => hasConflict.value,
    useTimeblockWriteMutations: () => ({
      createPlan: { mutate: createPlanMutate },
      createRecord: { mutate: createRecordMutate },
      deletePlan: { mutate: vi.fn() },
      deleteRecord: { mutate: vi.fn() },
    }),
    useTimeblockInspectorStore: Object.assign(
      (selector: (s: { openInspector: unknown; closeInspector: unknown }) => unknown) =>
        selector({ openInspector, closeInspector: vi.fn() }),
      { getState: () => ({ timeblockId: null }) },
    ),
  };
});

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; defaultDuration: number }) => unknown) =>
    selector({ timezone: 'UTC', defaultDuration: 60 }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

describe('useActivityQuickCreate', () => {
  beforeEach(() => {
    hasConflict.value = false;
    createPlanMutate.mockClear();
    createRecordMutate.mockClear();
    openInspector.mockClear();
  });

  it('タップした時点で既定の長さのブロックを保存する', () => {
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });

    expect(createPlanMutate).toHaveBeenCalledTimes(1);
    const [input] = createPlanMutate.mock.calls[0] as [
      { title: string; activityId: string; start_at: string; end_at: string },
    ];
    expect(input.title).toBe('開発');
    expect(input.activityId).toBe('activity-1');
    const durationMinutes =
      (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    expect(durationMinutes).toBe(60);
  });

  it('保存できたら作ったブロックを詳細パネルで開く', () => {
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });

    const [, options] = createPlanMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (created: { id: string; updated_at: string }) => void },
    ];
    options.onSuccess({ id: 'plan-1', updated_at: '2026-09-07T00:00:00.000Z' });

    expect(openInspector).toHaveBeenCalledWith('plan-1', 'plan');
  });

  it('既定の枠が同じレーンの既存ブロックと重なる時は作成しない', () => {
    hasConflict.value = true;
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });

    expect(createPlanMutate).not.toHaveBeenCalled();
    expect(createRecordMutate).not.toHaveBeenCalled();
    expect(openInspector).not.toHaveBeenCalled();
  });

  it('過去日をタップした時は記録として保存する', () => {
    const { result } = renderHook(() => useActivityQuickCreate());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    result.current({ activityId: 'activity-1', activityName: '開発', date: yesterday });

    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createPlanMutate).not.toHaveBeenCalled();
  });
});
