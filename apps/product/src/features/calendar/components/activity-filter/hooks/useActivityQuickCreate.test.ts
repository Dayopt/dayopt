/**
 * サイドバー / チップ行のタップからの即作成。
 *
 * 「タップした時点で保存され、作ったブロックが詳細パネルで開く」ことと、
 * 保存先が end_at のルールで決まること、長さが記録の中央値（無ければ設定の
 * 既定の長さ）になることを確認する。
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useActivityQuickCreate } from './useActivityQuickCreate';

const hasConflict = vi.hoisted(() => ({ value: false }));
/** 同一レーンに既にあるブロック。空き探しの入力になる */
const laneItems = vi.hoisted(() => ({
  value: [] as Array<{ id: string; start_at: string; end_at: string }>,
}));
const createPlanMutate = vi.hoisted(() => vi.fn());
const createRecordMutate = vi.hoisted(() => vi.fn());
const openInspector = vi.hoisted(() => vi.fn());
/** activityId → 記録の中央値（分）。空なら設定の既定の長さへフォールバックする */
const medianMinutes = vi.hoisted(() => ({ value: new Map<string, number>() }));

vi.mock('@/features/timeblock', async () => {
  const domain = await vi.importActual<
    typeof import('@/features/timeblock/domain/timeblock-destination')
  >('@/features/timeblock/domain/timeblock-destination');
  // 空き探しは本物を使う。ここで見たいのは hook がその結果どおりに作るかどうか
  const lane = await vi.importActual<
    typeof import('@/features/timeblock/lib/timeblock-lane-conflict')
  >('@/features/timeblock/lib/timeblock-lane-conflict');

  return {
    resolveTimeblockDestination: domain.resolveTimeblockDestination,
    collectTimeblockLaneItems: () => laneItems.value,
    hasTimeblockLaneConflict: () => hasConflict.value,
    findFreeTimeblockLaneSlot: lane.findFreeTimeblockLaneSlot,
    useTimeblockWriteMutations: () => ({
      createPlan: { mutate: createPlanMutate },
      createRecord: { mutate: createRecordMutate },
      deletePlan: { mutate: vi.fn() },
      deleteRecord: { mutate: vi.fn() },
    }),
    useActivityMedianDurations: () => ({
      medianByActivityId: medianMinutes.value,
      getMedianMinutes: (activityId: string | null) =>
        activityId == null ? null : (medianMinutes.value.get(activityId) ?? null),
    }),
    useTimeblockInspectorStore: Object.assign(
      (selector: (s: { openInspector: unknown; closeInspector: unknown }) => unknown) =>
        selector({ openInspector, closeInspector: vi.fn() }),
      { getState: () => ({ timeblockId: null }) },
    ),
  };
});

/**
 * ユーザー timezone は runner のローカルゾーンに合わせる。
 *
 * hook は「ブラウザローカルの壁時計を組み立て → ユーザー timezone として解釈」する
 * （`convertFromTimezone`）。ここを 'UTC' 固定にすると、UTC より西の runner では
 * 壁時計 09:00 が real now より数時間前の UTC 09:00 に読まれ、既定の枠が過去扱い
 * （記録）になって `createPlan` が呼ばれない。ローカルゾーンなら変換が恒等になり、
 * fixture も `new Date()` をそのまま使える。
 */
const RUNNER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; defaultDuration: number }) => unknown) =>
    selector({ timezone: RUNNER_TIMEZONE, defaultDuration: 60 }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

/**
 * 固定する「今」（ローカル 09:00）。
 *
 * この file の test は全て `new Date()` からの相対で fixture を組むため、実時計のまま
 * だと夜に落ちる: 既存ブロックを now+2h まで置く test は、ローカル 21 時以降だと空き
 * （+ 60 分）がその日の終わりを越えて `findFreeTimeblockLaneSlot` が null を返す。
 * 実行時刻に依存しないよう、朝の時刻へ固定する。ローカル時刻で組み立てるので
 * runner の timezone にも依存しない。
 */
const FIXED_NOW = new Date(2026, 8, 10, 9, 0, 0, 0);

describe('useActivityQuickCreate', () => {
  beforeEach(() => {
    // Date だけを偽装する。setTimeout 等を止めると Testing Library の描画が進まない
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);

    hasConflict.value = false;
    laneItems.value = [];
    medianMinutes.value = new Map();
    toastSuccess.mockClear();
    createPlanMutate.mockClear();
    createRecordMutate.mockClear();
    openInspector.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('中央値の無いアクティビティは設定の既定の長さで保存する', () => {
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

  it('記録の中央値があるアクティビティはその長さで保存する', () => {
    medianMinutes.value = new Map([['activity-1', 45]]);
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });

    const [input] = createPlanMutate.mock.calls[0] as [{ start_at: string; end_at: string }];
    const durationMinutes =
      (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    expect(durationMinutes).toBe(45);
  });

  it('中央値は他のアクティビティへ漏れない（自分の値が無ければ既定の長さ）', () => {
    medianMinutes.value = new Map([['activity-1', 45]]);
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-2', activityName: '読書' });

    const [input] = createPlanMutate.mock.calls[0] as [{ start_at: string; end_at: string }];
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

  it('予定として作ったら予定の文言を出す（記録とは言わない）', () => {
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });
    const [, options] = createPlanMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (created: { id: string; updated_at: string }) => void },
    ];
    options.onSuccess({ id: 'plan-1', updated_at: '2026-09-07T00:00:00.000Z' });

    expect(toastSuccess.mock.calls[0]?.[0]).toBe('timeblock.editor.toast.planCreated');
  });

  it('ずらして作った時は時刻つきの文言を出す', () => {
    const now = new Date();
    laneItems.value = [
      {
        id: 'existing',
        start_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        end_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });
    const [, options] = createPlanMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (created: { id: string; updated_at: string }) => void },
    ];
    options.onSuccess({ id: 'plan-1', updated_at: '2026-09-07T00:00:00.000Z' });

    expect(toastSuccess.mock.calls[0]?.[0]).toBe('timeblock.editor.toast.planCreatedShifted');
  });

  it('今の時間が埋まっている時は、直後の空きへずらして作る', () => {
    // 既定の開始（今）を含む 3 時間がふさがっている
    const now = new Date();
    laneItems.value = [
      {
        id: 'existing',
        start_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        end_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const { result } = renderHook(() => useActivityQuickCreate());

    result.current({ activityId: 'activity-1', activityName: '開発' });

    expect(createPlanMutate).toHaveBeenCalledTimes(1);
    const [input] = createPlanMutate.mock.calls[0] as [{ start_at: string; end_at: string }];
    // 既存の終わりから、既定の長さのまま作る（縮めない）
    expect(input.start_at).toBe(laneItems.value[0]?.end_at);
    const durationMinutes =
      (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    expect(durationMinutes).toBe(60);
  });

  it('その日にもう空きが無ければ作成しない', () => {
    const localNow = new Date();
    const localEndOfDay = new Date(localNow);
    localEndOfDay.setHours(23, 59, 59, 999);
    laneItems.value = [
      {
        id: 'all-day',
        start_at: new Date(localNow.getTime() - 60 * 60 * 1000).toISOString(),
        // 探す上限（その日の終わり）まで埋まっているので、長さが入る空きは残らない
        end_at: localEndOfDay.toISOString(),
      },
    ];
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
