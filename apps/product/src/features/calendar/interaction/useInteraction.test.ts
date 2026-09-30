import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimeblockRect } from '../domain/interaction/types';
import { useCalendarDragStore } from '../stores/useCalendarDragStore';
import type { CalendarDisplayEvent } from '../types/calendar.types';
import { useInteraction, type UseInteractionProps } from './useInteraction';

const baseEvent: CalendarDisplayEvent = {
  id: 'timeblock-1',
  title: 'test timeblock',
  startDate: new Date('2026-01-15T09:00:00'),
  endDate: new Date('2026-01-15T10:00:00'),
  origin: 'manual',
  kind: 'plan',
  version: '2026-01-15T08:00:00.000000Z',
} as unknown as CalendarDisplayEvent;

const counterpartRecordAllDay: CalendarDisplayEvent = {
  ...baseEvent,
  id: 'counterpart-record',
  kind: 'record',
  startDate: new Date('2026-01-15T00:00:00'),
  endDate: new Date('2026-01-15T23:59:00'),
  displayStartDate: new Date('2026-01-15T00:00:00'),
  displayEndDate: new Date('2026-01-15T23:59:00'),
} as unknown as CalendarDisplayEvent;

const rect: TimeblockRect = { top: 540, left: 0, width: 200, height: 60 };
const now = new Date('2026-01-15T12:00:00').getTime();

function createMouseEvent(clientX: number = 100, clientY: number = 540): React.MouseEvent {
  return {
    button: 0,
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: { clientX, clientY },
  } as unknown as React.MouseEvent;
}

function createTouchEvent(clientX: number = 100, clientY: number = 540): React.TouchEvent {
  return {
    type: 'touchstart',
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: {
      type: 'touchstart',
      touches: [{ clientX, clientY }],
    },
  } as unknown as React.TouchEvent;
}

function makeProps(overrides: Partial<UseInteractionProps> = {}): UseInteractionProps {
  return {
    date: new Date('2026-01-15T00:00:00'),
    events: [baseEvent],
    hourHeight: 60,
    viewMode: 'day',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  useCalendarDragStore.getState().endDrag();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('[data-calendar-day-index]').forEach((element) => element.remove());
});

function completeDrag(hook: { result: { current: ReturnType<typeof useInteraction> } }) {
  act(() => {
    hook.result.current.dispatch({
      type: 'POINTER_DOWN',
      timeblockId: 'timeblock-1',
      point: { clientX: 20, clientY: 540 },
      originalPosition: rect,
      dateIndex: 0,
    });
    hook.result.current.dispatch({
      type: 'POINTER_MOVE',
      point: { clientX: 80, clientY: 570 },
    });
  });
}

function dropAtRightLaneArea(
  hook: { result: { current: ReturnType<typeof useInteraction> } },
  moveY: number = 570,
): void {
  act(() => {
    hook.result.current.dispatch({
      type: 'POINTER_DOWN',
      timeblockId: 'timeblock-1',
      point: { clientX: 20, clientY: 540 },
      originalPosition: rect,
      dateIndex: 0,
    });
    hook.result.current.dispatch({
      type: 'POINTER_MOVE',
      point: { clientX: 180, clientY: moveY },
    });
    hook.result.current.dispatch({ type: 'POINTER_UP' });
  });
}

describe('useInteraction Plan drag', () => {
  it('Recordと同じ領域へdropしてもPlanの時刻を更新する', () => {
    const onEventUpdate = vi.fn();
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [baseEvent, counterpartRecordAllDay], onEventUpdate })),
    );

    dropAtRightLaneArea(hook);

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T09:30:00'),
        endTime: new Date('2026-01-15T10:30:00'),
      }),
    );
  });

  it('Recordと重なる場所へ移動してもRecord重複として拒否しない', () => {
    const onEventUpdate = vi.fn();
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [baseEvent, counterpartRecordAllDay], onEventUpdate })),
    );

    act(() => {
      hook.result.current.dispatch({
        type: 'POINTER_DOWN',
        timeblockId: 'timeblock-1',
        point: { clientX: 20, clientY: 540 },
        originalPosition: rect,
        dateIndex: 0,
      });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 570 }));
    });

    expect(hook.result.current.state.mode).toBe('dragging');
    expect(hook.result.current.state).toMatchObject({
      previewTime: {
        start: new Date('2026-01-15T09:30:00'),
        end: new Date('2026-01-15T10:30:00'),
      },
    });

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));
    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T09:30:00'),
        endTime: new Date('2026-01-15T10:30:00'),
      }),
    );
  });

  it('タグフィルターで非表示のRecordと重なるPlan移動を許可する', () => {
    const onEventUpdate = vi.fn();
    const record = {
      ...baseEvent,
      id: 'record-1',
      kind: 'record' as const,
      startDate: new Date('2026-01-15T09:15:00'),
      endDate: new Date('2026-01-15T10:45:00'),
    };
    const hook = renderHook(() =>
      useInteraction(
        makeProps({
          events: [baseEvent],
          allEventsForOverlapCheck: [baseEvent, record],
          onEventUpdate,
        }),
      ),
    );

    act(() => {
      hook.result.current.dispatch({
        type: 'POINTER_DOWN',
        timeblockId: 'timeblock-1',
        point: { clientX: 20, clientY: 540 },
        originalPosition: rect,
        dateIndex: 0,
      });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 570 }));
    });

    expect(hook.result.current.state).toMatchObject({ mode: 'dragging', isOverlapping: false });

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T09:30:00'),
        endTime: new Date('2026-01-15T10:30:00'),
      }),
    );
  });

  it('別のPlanと重なる移動は拒否する', () => {
    const onEventUpdate = vi.fn();
    const overlappingPlan = {
      ...baseEvent,
      id: 'plan-2',
      startDate: new Date('2026-01-15T09:15:00'),
      endDate: new Date('2026-01-15T10:45:00'),
    };
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [baseEvent, overlappingPlan], onEventUpdate })),
    );

    act(() => {
      hook.result.current.dispatch({
        type: 'POINTER_DOWN',
        timeblockId: 'timeblock-1',
        point: { clientX: 20, clientY: 540 },
        originalPosition: rect,
        dateIndex: 0,
      });
      hook.result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 180, clientY: 570 },
      });
    });

    expect(hook.result.current.state).toMatchObject({ mode: 'dragging', isOverlapping: true });

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));
    expect(onEventUpdate).not.toHaveBeenCalled();
  });

  it('別のRecordと重なる移動は拒否する', () => {
    const onEventUpdate = vi.fn();
    const record = { ...baseEvent, kind: 'record' as const };
    const overlappingRecord = {
      ...record,
      id: 'record-2',
      startDate: new Date('2026-01-15T09:15:00'),
      endDate: new Date('2026-01-15T10:45:00'),
    };
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [record, overlappingRecord], onEventUpdate })),
    );

    act(() => {
      hook.result.current.dispatch({
        type: 'POINTER_DOWN',
        timeblockId: 'timeblock-1',
        point: { clientX: 20, clientY: 540 },
        originalPosition: rect,
        dateIndex: 0,
      });
      hook.result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 180, clientY: 570 },
      });
    });

    expect(hook.result.current.state).toMatchObject({ mode: 'dragging', isOverlapping: true });

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));
    expect(onEventUpdate).not.toHaveBeenCalled();
  });

  /**
   * 制約は drop 先の時間帯だけ（DT005）。Plan 自身が未来に終わるかは見ない。
   *
   * Plan の時間編集に Record の未来終了制約を適用しないことを維持する。
   * 「未来 Plan」の特別扱いは #2598 で撤去済み（#2645）。
   * DB は過去に終わる Record を未来 Plan へ紐付けられる
   * （timeblock-atomic-commands.integration.test.ts が real DB で固定）。
   */
  it.each([
    [
      'active Plan',
      {
        ...baseEvent,
        startDate: new Date('2026-01-15T11:00:00'),
        endDate: new Date('2026-01-15T13:00:00'),
      },
      '2026-01-15T11:30:00',
    ],
    [
      'future Plan',
      {
        ...baseEvent,
        startDate: new Date('2026-01-16T09:00:00'),
        endDate: new Date('2026-01-16T10:00:00'),
      },
      '2026-01-15T10:30:00',
    ],
  ])('%sは他方のレーン側へdragしてもPlanの時刻を更新する', (_label, event, expectedEnd) => {
    const onEventUpdate = vi.fn();
    const hook = renderHook(() => useInteraction(makeProps({ events: [event], onEventUpdate })));

    dropAtRightLaneArea(hook);

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T09:30:00'),
        endTime: new Date(expectedEnd),
      }),
    );
  });

  it('drop previewの終了が未来でもPlanの時刻を更新する', () => {
    const onEventUpdate = vi.fn();
    const hook = renderHook(() => useInteraction(makeProps({ onEventUpdate })));

    dropAtRightLaneArea(hook, 720);

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T12:00:00'),
        endTime: new Date('2026-01-15T13:00:00'),
      }),
    );
  });

  // Plan は時間軸のどこにでも置ける（AGENTS.md §時間 / docs/product/specs/plan-record.md）。
  // 旧 DT006（過去 Plan の時刻変更禁止）を DB / service から撤去した後も drop の
  // コミット経路だけガードが残り、過去 Plan が元位置へスナップバックしていた。
  it('過去Planの同一レーンdropも時間更新する', () => {
    const onEventUpdate = vi.fn();
    const pastPlan = {
      ...baseEvent,
      startDate: new Date('2020-01-15T09:00:00'),
      endDate: new Date('2020-01-15T10:00:00'),
    };
    const hook = renderHook(() => useInteraction(makeProps({ events: [pastPlan], onEventUpdate })));

    completeDrag(hook);
    act(() => {
      hook.result.current.dispatch({ type: 'POINTER_UP' });
    });

    // 「呼ばれた」だけでは移動が反映された証拠にならないので、drag で 30 分ぶん
    // 下げた preview 時刻がそのまま渡ることまで見る。
    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({
        startTime: new Date('2026-01-15T09:30:00'),
        endTime: new Date('2026-01-15T10:30:00'),
      }),
    );
  });
});

describe('useInteraction handlePointerDown: 詳細を開いているブロック', () => {
  it('クリックを二重に届けない（カードの onClick が届けるので何もしない）', () => {
    const onEventClick = vi.fn();
    const { result } = renderHook(() =>
      useInteraction(makeProps({ disabledPlanId: baseEvent.id, onEventClick })),
    );

    act(() => {
      result.current.handlers.handlePointerDown(baseEvent.id, createMouseEvent(), rect);
    });

    // ここで呼ぶと 1 クリックが 2 回届き、開閉のトグルが打ち消し合う
    expect(onEventClick).not.toHaveBeenCalled();
    // drag も始めない
    expect(result.current.state.mode).toBe('idle');
  });

  it('別のブロックなら従来どおり drag の判定へ入る', () => {
    const onEventClick = vi.fn();
    const { result } = renderHook(() =>
      useInteraction(makeProps({ disabledPlanId: 'timeblock-other', onEventClick })),
    );

    act(() => {
      result.current.handlers.handlePointerDown(baseEvent.id, createMouseEvent(), rect);
    });

    expect(onEventClick).not.toHaveBeenCalled();
    expect(result.current.state.mode).not.toBe('idle');
  });
});

describe('useInteraction handleResizeStart guard', () => {
  it('PC + Inspector open: disabledPlanId と resizeDisabledPlanId が同じ ID のとき RESIZE_START を block', () => {
    const { result } = renderHook(() =>
      useInteraction(
        makeProps({
          disabledPlanId: 'timeblock-1',
          resizeDisabledPlanId: 'timeblock-1',
        }),
      ),
    );

    expect(result.current.state.mode).toBe('idle');

    act(() => {
      result.current.handlers.handleResizeStart('timeblock-1', 'bottom', createMouseEvent(), rect);
    });

    expect(result.current.state.mode).toBe('idle');
  });

  it('Touch入力は resizeDisabledPlanId が null でも RESIZE_START を開始しない', () => {
    const { result } = renderHook(() =>
      useInteraction(
        makeProps({
          disabledPlanId: 'timeblock-1',
          resizeDisabledPlanId: null,
        }),
      ),
    );

    act(() => {
      result.current.handlers.handleResizeStart('timeblock-1', 'bottom', createTouchEvent(), rect);
    });

    expect(result.current.state.mode).toBe('idle');
  });

  it('Inspector closed: 両 prop が null/undefined のとき RESIZE_START が dispatch される', () => {
    const { result } = renderHook(() => useInteraction(makeProps()));

    act(() => {
      result.current.handlers.handleResizeStart('timeblock-1', 'bottom', createMouseEvent(), rect);
    });

    expect(result.current.state.mode).toBe('resizing');
  });

  it('別 timeblock 対象: resizeDisabledPlanId が別 ID のとき RESIZE_START が dispatch される', () => {
    const { result } = renderHook(() =>
      useInteraction(
        makeProps({
          disabledPlanId: 'timeblock-other',
          resizeDisabledPlanId: 'timeblock-other',
        }),
      ),
    );

    act(() => {
      result.current.handlers.handleResizeStart('timeblock-1', 'bottom', createMouseEvent(), rect);
    });

    expect(result.current.state.mode).toBe('resizing');
  });
});

describe('useInteraction resize completion', () => {
  it('通常 timeblock の resize 完了時は actual 固定フラグを渡さない', () => {
    const onEventUpdate = vi.fn();
    const matchingTimeblock: CalendarDisplayEvent = {
      ...baseEvent,
    };
    const { result } = renderHook(() =>
      useInteraction(makeProps({ events: [matchingTimeblock], onEventUpdate })),
    );

    act(() => {
      result.current.dispatch({
        type: 'RESIZE_START',
        timeblockId: 'timeblock-1',
        direction: 'bottom',
        point: { clientX: 100, clientY: 600 },
        originalPosition: rect,
      });
    });
    act(() => {
      result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 100, clientY: 615 },
      });
    });
    act(() => {
      result.current.dispatch({ type: 'POINTER_UP' });
    });

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.not.objectContaining({ keepActualTime: true }),
    );
  });

  it('予定と記録がズレた timeblock の resize 完了時も actual 固定フラグは渡さない（自動記録モデルでは planned のみ更新）', () => {
    const onEventUpdate = vi.fn();
    const overtimeTimeblock: CalendarDisplayEvent = {
      ...baseEvent,
    };
    const { result } = renderHook(() =>
      useInteraction(makeProps({ events: [overtimeTimeblock], onEventUpdate })),
    );

    act(() => {
      result.current.dispatch({
        type: 'RESIZE_START',
        timeblockId: 'timeblock-1',
        direction: 'bottom',
        point: { clientX: 100, clientY: 600 },
        originalPosition: rect,
      });
      result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 100, clientY: 615 },
      });
      result.current.dispatch({ type: 'POINTER_UP' });
    });

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.not.objectContaining({ keepActualTime: true }),
    );
  });
});

describe('useInteraction gesture cancellation', () => {
  it.each(['touchcancel', 'pointercancel'])(
    '%s cancels a resize without saving its preview',
    (type) => {
      const onEventUpdate = vi.fn();
      const { result } = renderHook(() => useInteraction(makeProps({ onEventUpdate })));

      act(() => {
        result.current.dispatch({
          type: 'RESIZE_START',
          timeblockId: 'timeblock-1',
          direction: 'bottom',
          point: { clientX: 100, clientY: 540 },
          originalPosition: rect,
        });
        result.current.dispatch({
          type: 'POINTER_MOVE',
          point: { clientX: 100, clientY: 570 },
        });
      });
      expect(result.current.state.mode).toBe('resizing');

      act(() => {
        document.dispatchEvent(new Event(type));
      });

      expect(result.current.state.mode).toBe('idle');
      expect(onEventUpdate).not.toHaveBeenCalled();
    },
  );
});

describe('useInteraction optimistic version', () => {
  it('drag開始後にcacheが更新されても開始時のraw versionで更新する', () => {
    const onEventUpdate = vi.fn();
    const originalVersion = '2026-01-15T08:00:00.000001Z';
    const refreshedVersion = '2026-01-15T08:00:00.000002Z';
    const originalEvent: CalendarDisplayEvent = {
      ...baseEvent,
      kind: 'record',
      version: originalVersion,
    };
    const { result, rerender } = renderHook(
      ({ events }: { events: CalendarDisplayEvent[] }) =>
        useInteraction(makeProps({ events, onEventUpdate })),
      { initialProps: { events: [originalEvent] } },
    );

    act(() => {
      result.current.handlers.handlePointerDown('timeblock-1', createMouseEvent(20, 540), rect);
      result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 80, clientY: 570 },
      });
    });

    rerender({ events: [{ ...originalEvent, version: refreshedVersion }] });
    act(() => result.current.dispatch({ type: 'POINTER_UP' }));

    expect(onEventUpdate).toHaveBeenCalledWith(
      'timeblock-1',
      expect.objectContaining({ expectedUpdatedAt: originalVersion }),
    );
  });
});

describe('useInteraction selection completion', () => {
  it('passes day-end selection as 24:00 instead of next-day 0:00', () => {
    let selection: {
      date: Date;
      startHour: number;
      startMinute: number;
      endHour: number;
      endMinute: number;
    } | null = null;
    const { result } = renderHook(() =>
      useInteraction(
        makeProps({
          onTimeRangeSelect: (next) => {
            selection = next;
          },
        }),
      ),
    );

    act(() => {
      result.current.dispatch({
        type: 'GRID_POINTER_DOWN',
        point: { clientX: 100, clientY: 1425 },
        dateIndex: 0,
        gridY: 1425,
      });
      result.current.dispatch({
        type: 'POINTER_MOVE',
        point: { clientX: 100, clientY: 1445 },
      });
      result.current.dispatch({ type: 'POINTER_UP' });
    });

    expect(selection).toMatchObject({
      startHour: 23,
      startMinute: 45,
      endHour: 24,
      endMinute: 0,
      // 範囲を引いた選択なので、アクティビティの普段の長さで上書きしない
      durationSource: 'dragged',
    });
  });
});
