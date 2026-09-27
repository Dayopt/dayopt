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

/**
 * #2250: pointer→lane 判定は相手レーンに timeblock が無い時刻ではフル幅（境界不可視）扱いになり
 * sourceLane を維持する。「Record レーンへ入る」挙動そのものを検証する test では、
 * 判定対象の時間帯に必ず重なる counterpart Record（終日）を明示的に用意する。
 */
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

function createDayColumn(): HTMLElement {
  const column = document.createElement('div');
  column.dataset.calendarDayIndex = '0';
  column.getBoundingClientRect = () =>
    ({
      bottom: 1440,
      height: 1440,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(column);
  return column;
}

function dropIntoRecordLane(
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
    useCalendarDragStore.getState().updateDrag({ targetLane: 'record' });
    hook.result.current.dispatch({ type: 'POINTER_UP' });
  });
}

describe('useInteraction Plan → Record drop', () => {
  it('Recordレーンへのdropはplan更新ではなく記録mutationへ委譲する', () => {
    const onEventUpdate = vi.fn();
    const onPlanRecord = vi.fn();
    const hook = renderHook(() => useInteraction(makeProps({ onEventUpdate, onPlanRecord })));

    completeDrag(hook);
    act(() => {
      useCalendarDragStore.getState().updateDrag({ targetLane: 'record' });
      hook.result.current.dispatch({ type: 'POINTER_UP' });
    });

    expect(onPlanRecord).toHaveBeenCalledWith('timeblock-1', {
      start: new Date('2026-01-15T09:30:00'),
      end: new Date('2026-01-15T10:30:00'),
    });
    expect(onEventUpdate).not.toHaveBeenCalled();
  });

  // #2250 plan-review で検出した P1 故障モードそのものを固定する regression test。
  // counterpart（Record）が全く存在しない日は Plan がフル幅（境界不可視）で表示される。
  // 旧実装は pointer 判定が固定 38% 境界のままだったため、境界の見えないカラムの
  // 右側へドロップしただけで不可視のまま Plan→Record 変換 mutation が発火していた。
  it('counterpart Record が存在しない日では、旧境界の右側へドロップしても不可視のRecord変換mutationは発火しない', () => {
    createDayColumn();
    const onEventUpdate = vi.fn();
    const onPlanRecord = vi.fn();
    const hook = renderHook(() =>
      // events は baseEvent のみ（counterpart Record 無し）。rect.width=200 なので、
      // 旧固定境界（38%）は x=76。x=180 は旧境界の右側 = 旧実装なら 'record' に誤判定される位置。
      useInteraction(makeProps({ events: [baseEvent], onEventUpdate, onPlanRecord })),
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

    // 境界が見えない（counterpart が無い）ため、x 座標に関わらず sourceLane（'plan'）を維持する。
    expect(useCalendarDragStore.getState().targetLane).toBe('plan');

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));

    // 同一レーン（'plan' のまま）dropなので Record 変換は発火しない。
    // 時間更新は過去 Plan でも通常どおり走る（「過去Planの同一レーンdropも時間更新する」と同型）。
    expect(onPlanRecord).not.toHaveBeenCalled();
    expect(onEventUpdate).toHaveBeenCalled();
  });

  it('最初のmousemoveでRecordレーンへ入った場合もtarget laneとpreview rangeを保持する', () => {
    createDayColumn();
    const onPlanRecord = vi.fn();
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [baseEvent, counterpartRecordAllDay], onPlanRecord })),
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

    // #2250: pointer 判定は counterpart（境界）が存在する時刻でのみ x 座標で record に
    // 解決される。counterpartRecordAllDay（終日）が preview 区間に重なるため、targetLane は
    // 'record' に解決される。
    expect(hook.result.current.state.mode).toBe('dragging');
    expect(useCalendarDragStore.getState().targetLane).toBe('record');
    expect(hook.result.current.state).toMatchObject({
      previewTime: {
        start: new Date('2026-01-15T09:30:00'),
        end: new Date('2026-01-15T10:30:00'),
      },
    });

    // 同時刻に counterpart Record が既に存在するため、drop はスケジュール重複として
    // 拒否される（checkOverlap 経由、境界可視性とは独立した既存 guard。
    // 「タグフィルターで非表示のRecordとも重複を検出してdropを拒否する」と同型）。
    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));
    expect(onPlanRecord).not.toHaveBeenCalled();
  });

  it('連続dragでは前回のRecord targetを引き継がず最初のmousemoveでPlan laneへ戻る', () => {
    createDayColumn();
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [baseEvent, counterpartRecordAllDay] })),
    );

    act(() => {
      hook.result.current.handlers.handlePointerDown(
        'timeblock-1',
        createMouseEvent(20, 540),
        rect,
      );
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 570 }));
    });

    expect(useCalendarDragStore.getState().targetLane).toBe('record');

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));

    // 新しい drag を開始したら、前回の 'record' が stale state として引き継がれず、
    // 最初の mousemove で（x=40 は既定境界より左なので）'plan' に解決される。
    act(() => {
      hook.result.current.handlers.handlePointerDown(
        'timeblock-1',
        createMouseEvent(20, 540),
        rect,
      );
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 600 }));
    });

    expect(useCalendarDragStore.getState().targetLane).toBe('plan');

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));
  });

  it('タグフィルターで非表示のRecordとも重複を検出してdropを拒否する', () => {
    createDayColumn();
    const onPlanRecord = vi.fn();
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
          onPlanRecord,
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

    expect(hook.result.current.state).toMatchObject({ mode: 'dragging', isOverlapping: true });

    act(() => hook.result.current.dispatch({ type: 'POINTER_UP' }));

    expect(onPlanRecord).not.toHaveBeenCalled();
  });

  /**
   * 制約は drop 先の時間帯だけ（DT005）。Plan 自身が未来に終わるかは見ない。
   *
   * 以前はここが「記録callbackを呼ばない」を assert しており、撤去済み DT013
   * （#2598 で消した「未来 Plan」の特別扱い）を緑で固定していた（#2645）。
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
    ],
    [
      'future Plan',
      {
        ...baseEvent,
        startDate: new Date('2026-01-16T09:00:00'),
        endDate: new Date('2026-01-16T10:00:00'),
      },
    ],
  ])('%sでもdrop先が過去ならRecordレーンへのdropで記録callbackを呼ぶ', (_label, event) => {
    const onEventUpdate = vi.fn();
    const onPlanRecord = vi.fn();
    const hook = renderHook(() =>
      useInteraction(makeProps({ events: [event], onEventUpdate, onPlanRecord })),
    );

    dropIntoRecordLane(hook);

    expect(onPlanRecord).toHaveBeenCalledTimes(1);
    expect(onEventUpdate).not.toHaveBeenCalled();
  });

  it('drop previewの終了が未来なら過去Planでも記録callbackを呼ばない', () => {
    const onEventUpdate = vi.fn();
    const onPlanRecord = vi.fn();
    const hook = renderHook(() => useInteraction(makeProps({ onEventUpdate, onPlanRecord })));

    dropIntoRecordLane(hook, 720);

    expect(onPlanRecord).not.toHaveBeenCalled();
    expect(onEventUpdate).not.toHaveBeenCalled();
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
