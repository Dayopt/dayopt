/**
 * computeSelectionMove のユニットテスト
 *
 * Y 座標 → 選択範囲・ドラッグ判定・スナップ変化・重複判定の計算を検証する。
 * hourHeight=60 なので 1px = 1分（9:00 = 540px）。選択は 15 分の絶対 snap。
 */

import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';
import { computeSelectionMove, type SelectionMoveInput } from './selection-move';

// 未来日に固定して overlap 判定の kind が 'plan' になるようにする
const date = new Date('2099-01-15T00:00:00');

function makeInput(overrides: Partial<SelectionMoveInput> = {}): SelectionMoveInput {
  return {
    y: 600,
    hourHeight: 60,
    start: { hour: 9, minute: 0 },
    startPixelY: 540,
    hasDragged: false,
    date,
    plans: [],
    lastSnap: null,
    ...overrides,
  };
}

function makePlan(startHour: number, endHour: number): CalendarDisplayEvent {
  const startDate = new Date(date);
  startDate.setHours(startHour, 0, 0, 0);
  const endDate = new Date(date);
  endDate.setHours(endHour, 0, 0, 0);
  return { id: 'plan-1', kind: 'plan', startDate, endDate } as CalendarDisplayEvent;
}

describe('computeSelectionMove', () => {
  it('下方向ドラッグで選択範囲を計算し、閾値超えで hasDragged になる', () => {
    const result = computeSelectionMove(makeInput());

    expect(result.selection).toEqual({
      startHour: 9,
      startMinute: 0,
      endHour: 10,
      endMinute: 0,
    });
    expect(result.hasDragged).toBe(true);
    expect(result.isOverlapping).toBe(false);
    expect(result.snap).toEqual({ startMin: 540, endMin: 600 });
  });

  it('開始位置より上へ動かしても最低 1 snap 分（15 分）の選択を維持する', () => {
    const result = computeSelectionMove(makeInput({ y: 500 }));

    expect(result.selection).toEqual({
      startHour: 9,
      startMinute: 0,
      endHour: 9,
      endMinute: 15,
    });
  });

  it('15 分粒度で選択範囲を計算する（9:37 の位置は 9:30 へ揃う）', () => {
    const result = computeSelectionMove(makeInput({ y: 577 }));

    expect(result.selection).toEqual({
      startHour: 9,
      startMinute: 0,
      endHour: 9,
      endMinute: 30,
    });
  });

  it('移動が閾値以下なら hasDragged にならない', () => {
    const result = computeSelectionMove(makeInput({ y: 543 }));
    expect(result.hasDragged).toBe(false);
  });

  it('一度 hasDragged になったら小さい移動でも維持する', () => {
    const result = computeSelectionMove(makeInput({ y: 541, hasDragged: true }));
    expect(result.hasDragged).toBe(true);
  });

  it('lastSnap が null（初回）は snapChanged にならない', () => {
    const result = computeSelectionMove(makeInput({ lastSnap: null }));
    expect(result.snapChanged).toBe(false);
  });

  it('ハプティック境界（5 分）を跨いだら snapChanged になる', () => {
    const result = computeSelectionMove(makeInput({ lastSnap: { startMin: 540, endMin: 615 } }));
    expect(result.snapChanged).toBe(true);
  });

  it('スナップ位置が同じなら snapChanged にならない', () => {
    const result = computeSelectionMove(makeInput({ lastSnap: { startMin: 540, endMin: 600 } }));
    expect(result.snapChanged).toBe(false);
  });

  it('同一 5 分区画内の移動では snapChanged にならない（振動連射防止）', () => {
    // y=601 → 15 分 snap で end 10:00。lastSnap end=600 と同じ 5 分区画（600-604）
    const result = computeSelectionMove(
      makeInput({ y: 601, lastSnap: { startMin: 540, endMin: 600 } }),
    );
    expect(result.snapChanged).toBe(false);
  });

  it('同一レーン（plan）の既存 entry と重なると isOverlapping になる', () => {
    const result = computeSelectionMove(makeInput({ plans: [makePlan(9, 10)] }));
    expect(result.isOverlapping).toBe(true);
  });

  it('重ならない entry では isOverlapping にならない', () => {
    const result = computeSelectionMove(makeInput({ plans: [makePlan(11, 12)] }));
    expect(result.isOverlapping).toBe(false);
  });
});
