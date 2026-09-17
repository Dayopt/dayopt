/**
 * グリッド計算エンジン — React/DOM依存ゼロの純粋関数
 *
 * time↔pixel変換、スナップ、グリッド寸法の計算を提供。
 * すべての関数は副作用を持たず、テスト容易性を保証する。
 */

import { MS_PER_MINUTE } from '@/lib/date';

import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../domain/precision';

/** SSRフォールバック用デフォルトの1時間高さ(px) */
const DEFAULT_HOUR_HEIGHT = 72;

/** イベントの最小高さ(px) — 1 分粒度 timeblock でも視認できる程度に低く設定 */
export const MIN_EVENT_HEIGHT = 14;

/** イベントスタイルの戻り値型（React.CSSProperties互換だがReact非依存） */
interface EventStyle {
  position: 'absolute';
  top: string;
  height: string;
  left: string;
  width: string;
  zIndex: number;
}

// コア計算は interaction/time-math.ts に委譲（プリミティブ版が正規ソース）
import { timeToPixels as timeToPixelsPrimitive } from '../domain/interaction/time-math';

/**
 * 時刻をピクセル位置に変換（Date版）
 * @param time - 変換する時刻
 * @param hourHeight - 1時間の高さ（デフォルト: 72px）
 * @returns Y座標（px）
 */
export function timeToPixels(time: Date, hourHeight: number = DEFAULT_HOUR_HEIGHT): number {
  return timeToPixelsPrimitive(time.getHours(), time.getMinutes(), hourHeight);
}

/**
 * ピクセル位置を時刻に変換
 * @param pixels - Y座標（px）
 * @param baseDate - 基準日
 * @param hourHeight - 1時間の高さ（デフォルト: 72px）
 * @returns 時刻
 */
export function pixelsToTime(
  pixels: number,
  baseDate: Date,
  hourHeight: number = DEFAULT_HOUR_HEIGHT,
): Date {
  const totalMinutes = (pixels * 60) / hourHeight;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);

  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

/**
 * イベントの位置スタイルを計算
 * @param start - 開始時刻
 * @param end - 終了時刻
 * @param column - 列番号（0ベース）
 * @param totalColumns - 総列数
 * @param hourHeight - 1時間の高さ
 * @returns CSSスタイルオブジェクト
 */
export function getEventStyle(
  start: Date,
  end: Date,
  column: number = 0,
  totalColumns: number = 1,
  hourHeight: number = DEFAULT_HOUR_HEIGHT,
): EventStyle {
  const top = timeToPixels(start, hourHeight);
  const bottom = timeToPixels(end, hourHeight);
  const height = Math.max(bottom - top, MIN_EVENT_HEIGHT);

  const width = 100 / totalColumns;
  const left = (100 / totalColumns) * column;

  return {
    position: 'absolute',
    top: `${top}px`,
    height: `${height}px`,
    left: `${left}%`,
    width: `${width}%`,
    zIndex: 10,
  };
}

/**
 * グリッドの総高さを計算
 * @param startHour - 開始時間（0-24）
 * @param endHour - 終了時間（0-24）
 * @param hourHeight - 1時間の高さ
 * @returns 総高さ（px）
 */
export function calculateGridHeight(
  startHour: number = 0,
  endHour: number = 24,
  hourHeight: number = DEFAULT_HOUR_HEIGHT,
): number {
  return (endHour - startHour) * hourHeight;
}

/**
 * イベントの継続時間を分で取得
 * @param start - 開始時刻
 * @param end - 終了時刻
 * @returns 継続時間（分）
 */
export function getDurationInMinutes(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / MS_PER_MINUTE);
}

// ========================================
// Layout → Position Conversion
// ========================================

/** TimeblockLayout から top/height を計算する共通関数 */
const ENTRY_PADDING = 2;

export function layoutTimeblockToVerticalPosition(
  start: Date,
  end: Date,
  hourHeight: number,
): { top: number; height: number } {
  const startHour = start.getHours() + start.getMinutes() / 60;
  const endHour = end.getHours() + end.getMinutes() / 60;
  const duration = Math.max(endHour - startHour, MIN_TIMEBLOCK_DURATION_MINUTES / 60);

  const top = startHour * hourHeight;
  const height = Math.max(duration * hourHeight - ENTRY_PADDING, MIN_EVENT_HEIGHT);

  return { top, height };
}

// ========================================
// Time Slot Generation
// ========================================

/** タイムスロット — 15分単位の時間区画 */
interface TimeSlot {
  time: string;
  hour: number;
  minute: number;
  label: string;
  isHour: boolean;
  isHalfHour: boolean;
  isQuarterHour: boolean;
}

/**
 * タイムスロット配列を生成（純粋関数）
 * @param startHour - 開始時間（デフォルト: 0）
 * @param endHour - 終了時間（デフォルト: 24）
 * @param interval - 間隔（分、デフォルト: 15）
 */
export function generateTimeSlots(
  startHour: number = 0,
  endHour: number = 24,
  interval: number = 15,
): TimeSlot[] {
  const slots: TimeSlot[] = [];

  for (let hour = startHour; hour < endHour; hour++) {
    for (let minute = 0; minute < 60; minute += interval) {
      const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

      slots.push({
        time: timeString,
        hour,
        minute,
        label: minute === 0 ? `${hour}:00` : timeString,
        isHour: minute === 0,
        isHalfHour: minute === 30,
        isQuarterHour: minute === 15 || minute === 45,
      });
    }
  }

  return slots;
}

// ========================================
// Timeblock Style Computation
// ========================================

/** タイムブロック位置情報 */
interface TimeblockPositionInput {
  id: string;
  top: number;
  height: number;
  left: number;
  width: number;
  zIndex: number;
  opacity?: number;
}

/** タイムブロック位置情報からCSSスタイルマップを生成（純粋関数） */
export function computeTimeblockStyles(positions: TimeblockPositionInput[]): Record<
  string,
  {
    position: 'absolute';
    top: string;
    height: string;
    left: string;
    width: string;
    zIndex: number;
    opacity: number;
  }
> {
  const styles: Record<
    string,
    {
      position: 'absolute';
      top: string;
      height: string;
      left: string;
      width: string;
      zIndex: number;
      opacity: number;
    }
  > = {};

  for (const pos of positions) {
    styles[pos.id] = {
      position: 'absolute',
      top: `${pos.top}px`,
      height: `${pos.height}px`,
      left: `${pos.left}%`,
      width: `${pos.width}%`,
      zIndex: pos.zIndex,
      opacity: pos.opacity ?? 1.0,
    };
  }

  return styles;
}
