/**
 * グリッドシステムの定数定義
 */

/** 1時間の高さ（px）— SSRフォールバック用デフォルト */
export const HOUR_HEIGHT = 72; // 1時間の高さ(px) — SSRフォールバック用

/** グリッド全体の時間数（gridHeight = HOURS_PER_DAY * hourHeight の canonical 定数） */
export const HOURS_PER_DAY = 24;

// 密度プリセット（viewport フィットへの倍率）— feature lib/constants から re-export
export { DENSITY_FACTOR, MIN_LEGIBLE_HOUR_HEIGHT } from '../../../../lib/constants';

/**
 * 時間列の幅（px）。参照は `resolveTimeColumnWidth` 経由に限る
 *
 * ラベルは右詰め + 左右 8px padding（`TimeColumn` の `px-2`）なので、
 * 幅は「最長ラベル + 16px」を 8px グリッドへ切り上げた値にする。足りないと
 * 親の overflow-hidden がラベル先頭を切り、左余白が消える。
 *
 * 最長ラベル実測（Source Sans 3 / tabular-nums、headless Chromium）:
 * | 表記 | 最長        | text-sm 14px | text-xs 12px |
 * | ---- | ----------- | ------------ | ------------ |
 * | 24h  | `09:00`     | 35.0px       | 30.0px       |
 * | 12h  | `12:00 PM`  | 59.9px       | 51.4px       |
 */
const TIME_COLUMN_WIDTH = 56; // 24h / text-sm: 35 + 16 = 51 → 56

/** 時間列の幅（px、12 時間表記）。12h / text-sm: 59.9 + 16 = 75.9 → 80 */
const TIME_COLUMN_WIDTH_12H = 80;

/**
 * モバイル版時間列の幅（px）。24h / text-xs: 30 + 16 = 46 → 48
 *
 * 旧値 40px は「"9:00" 等の短いラベル」を前提にしていたが、実際は `padStart` 済みの
 * `09:00` 固定 5 文字。text-sm では 35px あり、pr-2 の 8px を引いた 32px に収まらず
 * 左へはみ出して切れていた（左余白ゼロの原因）。
 */
const MOBILE_TIME_COLUMN_WIDTH = 48;

/** モバイル版時間列の幅（px、12 時間表記）。12h / text-xs: 51.4 + 16 = 67.4 → 72 */
const MOBILE_TIME_COLUMN_WIDTH_12H = 72;

/**
 * 時刻表記と密度から時間列の幅を解く唯一の入口。
 *
 * 幅とラベルサイズは対で決まる（dense = text-xs）。呼び出し元が個々の定数を
 * 選ぶと組み合わせを間違えてラベルが切れるため、ここへ集約する。
 */
export function resolveTimeColumnWidth(format: '12h' | '24h', dense: boolean): number {
  if (dense) {
    return format === '12h' ? MOBILE_TIME_COLUMN_WIDTH_12H : MOBILE_TIME_COLUMN_WIDTH;
  }
  return format === '12h' ? TIME_COLUMN_WIDTH_12H : TIME_COLUMN_WIDTH;
}

/** 現在時刻ドットのサイズ（px） */
export const CURRENT_TIME_DOT_SIZE = 6; // 現在時刻のドットサイズ(px)

/**
 * Z-index層の定義（カレンダーグリッド内ローカル）
 *
 * これは CalendarGridContent のエントリ層（absolute + z-20）が作る
 * stacking context **内側**の数値空間で、tokens/z-index.css のグローバル
 * スケール（z-dropdown: 50 等）とは意図的に別。数値が同じでも競合しない。
 * グローバルスケールへ「統一」してはいけない — 例えば DRAGGING(30) を
 * z-calendar-drag(1000) に寄せると POPOVER(40) との大小関係が反転する。
 */
export const Z_INDEX = {
  EVENTS: 10,
  CURRENT_TIME: 29,
  DRAGGING: 30,
  POPOVER: 40,
} as const;
