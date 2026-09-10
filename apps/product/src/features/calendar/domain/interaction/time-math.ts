/**
 * 時刻 ↔ ピクセル変換の唯一のソース
 *
 * React/DOM 依存ゼロ。DnDProvider / machine.ts / useDragSelection が共通利用。
 * snap interval policy は `../precision` の `DEFAULT_DRAG_SNAP_MINUTES` を canonical source とする。
 *
 * 絶対 snap（`pixelsToTime` / `snapToGrid`）は新規作成専用。既存ブロックの移動・
 * リサイズは `snapDeltaMinutes` + `pixelsToMinutesUnsnapped` の相対 snap を使い、
 * 元ブロックの分（10:07 の :07）を保持する。
 */

import { DEFAULT_DRAG_SNAP_MINUTES } from '../precision';

/** 当日 24:00 を表す分。終了時刻だけがこの値を取りうる（翌日 0:00 と同義）。 */
export const DAY_END_MINUTES = 24 * 60;

/** 開始時刻が取りうる分の上限（23:59）。 */
export const DAY_LAST_START_MINUTES = DAY_END_MINUTES - 1;

/**
 * Y座標 → 時刻（絶対 snap。新規作成用）
 *
 * 開始時刻は当日内に収める。丸めが 24:00 へ届いた場合は当日最後のグリッド
 * （15 分刻みなら 23:45）へ落とす。ここで 23:00 まで巻き戻すと、23:56 付近の
 * ドラッグ開始点が 56 分も手前へ飛ぶ。
 */
export function pixelsToTime(
  yPx: number,
  hourHeight: number,
  snapInterval: number = DEFAULT_DRAG_SNAP_MINUTES,
): { hour: number; minute: number } {
  if (hourHeight <= 0 || snapInterval <= 0) return { hour: 0, minute: 0 };

  const totalMinutes = (Math.max(0, yPx) / hourHeight) * 60;
  const snapped = Math.round(totalMinutes / snapInterval) * snapInterval;
  const maxStart = Math.floor(DAY_LAST_START_MINUTES / snapInterval) * snapInterval;
  const clamped = Math.max(0, Math.min(maxStart, snapped));

  return { hour: Math.floor(clamped / 60), minute: clamped % 60 };
}

/** 時刻 → Y座標 */
export function timeToPixels(hour: number, minute: number, hourHeight: number): number {
  return (hour + minute / 60) * hourHeight;
}

/** 分（当日 0:00 起点） → Y座標 */
export function minutesToPixels(minutes: number, hourHeight: number): number {
  return (minutes / 60) * hourHeight;
}

/** pixelsToTime + timeToPixels を一度にやる（interaction machine 用） */
export function snapToGrid(
  yPx: number,
  hourHeight: number,
  intervalMin: number = DEFAULT_DRAG_SNAP_MINUTES,
): { snappedTop: number; hour: number; minute: number } {
  const { hour, minute } = pixelsToTime(yPx, hourHeight, intervalMin);
  const snappedTop = timeToPixels(hour, minute, hourHeight);
  return { snappedTop, hour, minute };
}

/** 時刻 + duration → 終了時刻 */
export function addMinutesToTime(
  hour: number,
  minute: number,
  durationMinutes: number,
): { hour: number; minute: number } {
  const totalMinutes = hour * 60 + minute + durationMinutes;
  const endHour = Math.floor(totalMinutes / 60) % 24;
  const endMinute = totalMinutes % 60;
  return { hour: endHour, minute: endMinute };
}

/**
 * Y 座標 → 当日 0:00 起点の分（snap せず 1 分へ丸めるだけ）
 *
 * 相対 snap で「originalPosition.top をそのまま時刻に戻す」用途。ここで snap して
 * しまうと 10:07 のような非グリッド時刻を保持できない。
 *
 * @param maxMinutes 上限。開始側は `DAY_LAST_START_MINUTES`（23:59）、
 *   終了側は `DAY_END_MINUTES`（24:00 = 翌日 0:00）を渡す。
 */
export function pixelsToMinutesUnsnapped(
  yPx: number,
  hourHeight: number,
  maxMinutes: number = DAY_END_MINUTES,
): number {
  if (hourHeight <= 0) return 0;
  const totalMinutes = Math.round((Math.max(0, yPx) / hourHeight) * 60);
  return Math.max(0, Math.min(maxMinutes, totalMinutes));
}

/**
 * 移動量 px → snap 済みの移動量（分）
 *
 * 相対 snap の核。絶対位置ではなく deltaY だけを snap interval で量子化するので、
 * 10:07 の entry を 1 マス下げると 10:22 になる（10:15 へ吸着しない）。
 */
export function snapDeltaMinutes(
  deltaPx: number,
  hourHeight: number,
  intervalMin: number = DEFAULT_DRAG_SNAP_MINUTES,
): number {
  if (hourHeight <= 0 || intervalMin <= 0) return 0;
  const deltaMinutes = (deltaPx / hourHeight) * 60;
  return Math.round(deltaMinutes / intervalMin) * intervalMin;
}
