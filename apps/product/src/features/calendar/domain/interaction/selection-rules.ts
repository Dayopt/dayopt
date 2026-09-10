/**
 * Calendar 空白選択ルール — drag / 即時 (double-click) で選択範囲を組み立てる純粋関数
 *
 * useDragSelection から抽出した React 非依存ロジック。useReducer や DOM event handler は
 * hook 側に残し、ここは「時間入力 → 時間範囲」の単純変換を担う。
 *
 * 制約:
 * - drag 選択は下方向のみ（start <= end）
 * - drag 選択は最低 1 snap 分（`MIN_TIMEBLOCK_DURATION_MINUTES` 未満にはしない）の長さを保証
 * - 即時選択 (createInstantSelection) は defaultDuration を当てて 24:00 を超えないように clamp
 */

import { DEFAULT_DRAG_SNAP_MINUTES, MIN_TIMEBLOCK_DURATION_MINUTES } from '../precision';

/** 時刻入力（hour: 0-23, minute: 0-59） */
/** @public Pending domain barrel contract cleanup in I-08. */
export interface HourMinute {
  hour: number;
  minute: number;
}

/** 時間範囲（hour / minute 表現） */
/** @public Pending domain barrel contract cleanup in I-08. */
export interface SelectionRange {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** 日付を含む時間範囲選択結果 */
/** @public Pending domain barrel contract cleanup in I-08. */
export interface DateSelectionRange extends SelectionRange {
  date: Date;
}

/**
 * 開始時刻と現在時刻から drag 選択範囲を計算する。
 *
 * - 下方向のみ（start より手前にはドラッグできない）
 * - 最低 1 snap 分の長さを保証（`machine` 側の `buildSelectionRange` と同じ下限）
 * - 0:00-23:59 にクランプ
 */
export function calculateSelection(
  start: HourMinute,
  current: HourMinute,
  intervalMin: number = DEFAULT_DRAG_SNAP_MINUTES,
): SelectionRange {
  const startMin = start.hour * 60 + start.minute;
  const currentMin = current.hour * 60 + current.minute;

  const minDurationMin = Math.max(intervalMin, MIN_TIMEBLOCK_DURATION_MINUTES);
  const endMin = Math.max(currentMin, startMin + minDurationMin);

  const startHour = Math.max(0, Math.floor(startMin / 60));
  const startMinute = Math.max(0, startMin % 60);
  const endHour = Math.min(23, Math.floor(endMin / 60));
  const endMinute = Math.min(59, endMin % 60);

  return { startHour, startMinute, endHour, endMinute };
}

/**
 * defaultDuration を使った即時選択範囲を作成する（double-click 用）。
 *
 * - 開始時刻 + defaultDuration を end とする
 * - 24:00 (= 1440 分) を超えないように 23:59 にクランプ
 */
export function createInstantSelection(
  time: HourMinute,
  date: Date,
  defaultDuration: number,
): DateSelectionRange {
  const startTotal = time.hour * 60 + time.minute;
  const endTotal = Math.min(startTotal + defaultDuration, 24 * 60 - 1);
  return {
    date,
    startHour: time.hour,
    startMinute: time.minute,
    endHour: Math.floor(endTotal / 60),
    endMinute: endTotal % 60,
  };
}
