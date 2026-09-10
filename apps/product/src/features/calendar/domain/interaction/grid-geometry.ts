/**
 * Interaction State Machine — グリッド幾何計算
 *
 * ピクセル ⇔ 時刻のスナップ、選択範囲・移動範囲・リサイズ範囲の構築。
 * React/DOM 依存ゼロの純粋関数のみ。
 *
 * snap の使い分け（`../precision` 参照）:
 * - 新規作成（`buildSelectionRange`）は**絶対 snap**。:00 / :15 / :30 / :45 に揃える
 * - 既存ブロックの移動 / リサイズ（`resolveMoveStartMinutes` / `resolveResizeEndMinutes`）は
 *   **相対 snap**。移動量だけを量子化し、元ブロックの分（10:07 の :07）を保持する
 */

import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../precision';
import {
  DAY_END_MINUTES,
  DAY_LAST_START_MINUTES,
  minutesToPixels,
  pixelsToMinutesUnsnapped,
  snapDeltaMinutes,
  snapToGrid,
} from './time-math';
import type { InteractionContext, Point, TimeRange } from './types';

export function maxAbsDelta(a: Point, b: Point): number {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY));
}

/** 当日 0:00 起点の分を Date にする。1440（24:00）は翌日 0:00 になる。 */
export function minutesToDate(baseDate: Date, minutes: number): Date {
  const result = new Date(baseDate);
  result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return result;
}

/** Resolve the target date for a given date index */
export function resolveTargetDate(ctx: InteractionContext, targetDateIndex: number): Date {
  if (ctx.viewMode !== 'day' && ctx.displayDates?.[targetDateIndex]) {
    return ctx.displayDates[targetDateIndex];
  }
  return ctx.date;
}

// ========================================
// 既存ブロックの移動（相対 snap）
// ========================================

/**
 * 移動後の開始時刻（分）を相対 snap で求める。
 *
 * 移動量だけを snap interval で量子化するので、10:07 の entry を 1 マス下げると
 * 10:22 になり 10:15 へ潰れない。ブロック全体が当日へ収まるよう
 * `[0, 24:00 - duration]` に clamp する。
 */
export function resolveMoveStartMinutes(params: {
  originalTopPx: number;
  deltaPx: number;
  hourHeight: number;
  intervalMin: number;
  durationMinutes: number;
}): number {
  const { originalTopPx, deltaPx, hourHeight, intervalMin, durationMinutes } = params;
  const originalStart = pixelsToMinutesUnsnapped(originalTopPx, hourHeight, DAY_LAST_START_MINUTES);
  const moved = originalStart + snapDeltaMinutes(deltaPx, hourHeight, intervalMin);
  const maxStart = Math.max(0, DAY_END_MINUTES - Math.max(0, durationMinutes));
  return Math.max(0, Math.min(maxStart, moved));
}

/**
 * 移動 preview の時間範囲。
 *
 * 長さは grid 上の見た目（wall clock の分）で保つ。絶対 ms で足すと DST 移行日に
 * ghost の高さと保存される長さが 1 時間ズレる。24:00 を超える分は翌日へ繰り上がる。
 */
export function buildMoveTimeRange(
  targetDate: Date,
  startMinutes: number,
  durationMinutes: number,
): TimeRange {
  const safeDuration = Math.max(durationMinutes, MIN_TIMEBLOCK_DURATION_MINUTES);
  return {
    start: minutesToDate(targetDate, startMinutes),
    end: minutesToDate(targetDate, startMinutes + safeDuration),
  };
}

// ========================================
// 既存ブロックのリサイズ（開始固定 + 終端の相対 snap）
// ========================================

/** リサイズ中も動かさない開始時刻（分）。snap せず元の分を保持する。 */
export function resolveResizeStartMinutes(originalTopPx: number, hourHeight: number): number {
  return pixelsToMinutesUnsnapped(originalTopPx, hourHeight, DAY_LAST_START_MINUTES);
}

/**
 * リサイズ後の終了時刻（分）を相対 snap で求める。
 *
 * 下限は「開始 + 最小ブロック長」と、Plan / Record がズレた entry の
 * `minEndMinutes`（確定済み actual start）の大きい方。後者はグリッド由来ではない
 * 実データの制約なので snap interval へ切り上げない。
 */
export function resolveResizeEndMinutes(params: {
  startMinutes: number;
  originalEndPx: number;
  deltaPx: number;
  hourHeight: number;
  intervalMin: number;
  minEndMinutes?: number | null;
}): number {
  const { startMinutes, originalEndPx, deltaPx, hourHeight, intervalMin, minEndMinutes } = params;
  const originalEnd = pixelsToMinutesUnsnapped(originalEndPx, hourHeight, DAY_END_MINUTES);
  const floor = Math.max(startMinutes + MIN_TIMEBLOCK_DURATION_MINUTES, minEndMinutes ?? 0);
  const moved = originalEnd + snapDeltaMinutes(deltaPx, hourHeight, intervalMin);
  return Math.min(DAY_END_MINUTES, Math.max(floor, moved));
}

/** リサイズ preview の高さ（px）。 */
export function resizeHeightPx(
  startMinutes: number,
  endMinutes: number,
  hourHeight: number,
): number {
  return minutesToPixels(Math.max(0, endMinutes - startMinutes), hourHeight);
}

// ========================================
// 新規作成の範囲選択（絶対 snap）
// ========================================

type GridSnap = ReturnType<typeof snapToGrid>;

function snapEndToGrid(yPx: number, hourHeight: number, intervalMin: number): GridSnap {
  const pxPerInterval = (hourHeight / 60) * intervalMin;
  if (pxPerInterval <= 0) return snapToGrid(yPx, hourHeight, intervalMin);

  const dayHeight = 24 * hourHeight;
  const clampedY = Math.max(0, Math.min(yPx, dayHeight));
  const snappedTop = Math.max(
    0,
    Math.min(dayHeight, Math.round(clampedY / pxPerInterval) * pxPerInterval),
  );
  const totalMinutes = Math.min(DAY_END_MINUTES, Math.round((snappedTop / hourHeight) * 60));

  return {
    snappedTop,
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
  };
}

function ensureEndAfterStartSnap(
  startSnap: GridSnap,
  endSnap: GridSnap,
  hourHeight: number,
  intervalMin: number,
): GridSnap {
  const minDurationMin = Math.max(intervalMin, MIN_TIMEBLOCK_DURATION_MINUTES);
  const minEndTop = Math.min(
    24 * hourHeight,
    startSnap.snappedTop + (hourHeight / 60) * minDurationMin,
  );
  if (endSnap.snappedTop >= minEndTop) return endSnap;

  return snapEndToGrid(minEndTop, hourHeight, intervalMin);
}

/** Build a time range for a grid selection (downward only from startY) */
export function buildSelectionRange(
  startY: number,
  endY: number,
  hourHeight: number,
  targetDate: Date,
  intervalMin: number,
): TimeRange {
  const startSnap = snapToGrid(startY, hourHeight, intervalMin);
  // 下方向のみ: endY が startY より上なら startY に固定
  const clampedEndY = Math.max(endY, startY);
  let endSnap = snapEndToGrid(clampedEndY, hourHeight, intervalMin);
  endSnap = ensureEndAfterStartSnap(startSnap, endSnap, hourHeight, intervalMin);

  const start = new Date(targetDate);
  start.setHours(startSnap.hour, startSnap.minute, 0, 0);
  const end = new Date(targetDate);
  end.setHours(endSnap.hour, endSnap.minute, 0, 0);

  return { start, end };
}
