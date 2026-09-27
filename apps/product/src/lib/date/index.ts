/**
 * 日付ユーティリティライブラリ
 *
 * `@/lib/date` 経由で実際に参照されている API のみ re-export。
 * deep import (`@/lib/date/core`, `@/lib/date/duration`, `@/lib/date/timeString`,
 * `@/lib/date/timezone`, `@/lib/date/constants`) も並行して利用可能。
 */

// ========================================
// Core - 基本的な日付計算
// ========================================
export { addDays, getDateKey, isSameDay, startOfWeek, subDays } from './core';

// ========================================
// Duration - 期間フォーマット
// ========================================
export { formatDurationMinutes } from './duration';

// ========================================
// TimeString - "HH:mm" パース / フォーマット
// ========================================
export {
  computeDuration,
  formatHHmm,
  formatTimeRange,
  formatTimeString,
  parseTimeString,
} from './timeString';

// ========================================
// 定数の再エクスポート
// ========================================
export { CACHE_5_MINUTES, MS_PER_MINUTE } from './constants';
