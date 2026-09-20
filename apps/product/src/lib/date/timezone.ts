/**
 * タイムゾーンユーティリティ
 *
 * date-fns-tz をベースにしたタイムゾーン変換・フォーマット。
 * アプリ全体で統一されたタイムゾーン処理を提供。
 *
 * @example
 * ```typescript
 * import { convertToTimezone, getTimezoneAbbreviation } from '@/lib/date/timezone';
 *
 * const localDate = convertToTimezone(utcDate, userTz);
 * const abbr = getTimezoneAbbreviation(userTz); // "JST"
 * ```
 */

import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

import { getDateKey } from './core';

// ========================================
// タイムゾーン変換
// ========================================

/**
 * UTC時刻を指定タイムゾーンの時刻に変換
 *
 * **注意**: 返されるDateオブジェクトのgetHours()等は指定TZでの値を返す
 *
 * @param utcDate - UTC日時
 * @param timezone - 変換先タイムゾーン（例: 'Asia/Tokyo'）
 * @returns タイムゾーン変換されたDateオブジェクト
 *
 * @example
 * ```typescript
 * // UTC 05:00 → JST 14:00
 * const jstDate = convertToTimezone(new Date('2025-01-22T05:00:00Z'), 'Asia/Tokyo');
 * jstDate.getHours(); // => 14
 * ```
 */
export function convertToTimezone(utcDate: Date, timezone: string): Date {
  return toZonedTime(utcDate, timezone);
}

/**
 * 指定タイムゾーンの時刻をUTCに変換
 *
 * @param zonedDate - タイムゾーン付き日時
 * @param timezone - 元のタイムゾーン（例: 'Asia/Tokyo'）
 * @returns UTC Dateオブジェクト
 *
 * @example
 * ```typescript
 * // JST 14:00 → UTC 05:00
 * const utcDate = convertFromTimezone(localDate, 'Asia/Tokyo');
 * ```
 */
export function convertFromTimezone(zonedDate: Date, timezone: string): Date {
  return fromZonedTime(zonedDate, timezone);
}

// ========================================
// タイムゾーン対応フォーマット
// ========================================

// ========================================
// ユーザータイムゾーン
// ========================================

/**
 * タイムゾーンの略称を取得
 *
 * @param timezone - タイムゾーン（例: 'Asia/Tokyo'）
 * @returns 略称（例: 'JST'）
 */
export function getTimezoneAbbreviation(timezone: string, date: Date = new Date()): string {
  // Intl API で動的に取得（DST切り替えを正しく反映: EST↔EDT, PST↔PDT等）
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((part) => part.type === 'timeZoneName');
    return tzPart?.value || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * タイムゾーンのオフセットを取得（時間単位）
 *
 * @param timezone - タイムゾーン
 * @param date - 基準日時（DST考慮）
 * @returns オフセット（例: 9 for JST）
 */
export function getTimezoneOffset(timezone: string, date: Date = new Date()): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
}

// ========================================
// ISO変換
// ========================================

/**
 * ユーザーのタイムゾーンの時刻をUTC ISO文字列に変換
 *
 * @param localDate - ローカル日付
 * @param hours - 時（0-23）
 * @param minutes - 分（0-59）
 * @param timezone - ユーザーのタイムゾーン
 * @returns UTC ISO 8601文字列
 *
 * @example
 * ```typescript
 * // JST 14:30 → UTC ISO
 * localTimeToUTCISO(new Date(2025, 0, 22), 14, 30, 'Asia/Tokyo');
 * // => "2025-01-22T05:30:00.000Z"
 * ```
 */
export function localTimeToUTCISO(
  localDate: Date,
  hours: number,
  minutes: number,
  timezone: string,
): string {
  const year = localDate.getFullYear();
  const month = localDate.getMonth();
  const day = localDate.getDate();

  const zonedDate = new Date(year, month, day, hours, minutes, 0, 0);
  const utcDate = fromZonedTime(zonedDate, timezone);

  return utcDate.toISOString();
}

/**
 * ISO 8601文字列をユーザーのタイムゾーンで解釈したDateに変換
 *
 * @param isoString - ISO 8601形式の日時文字列
 * @param timezone - ユーザーのタイムゾーン
 * @returns タイムゾーン変換されたDateオブジェクト
 */
export function parseISOToUserTimezone(isoString: string, timezone: string): Date {
  const utcDate = new Date(isoString);
  if (isNaN(utcDate.getTime())) {
    throw new Error(`Invalid ISO datetime: ${isoString}`);
  }
  return toZonedTime(utcDate, timezone);
}

// ========================================
// TZ境界ヘルパー
// ========================================

/**
 * 2つのUTC DateがユーザーTZで同じ日かどうか
 *
 * @param a - 比較対象1
 * @param b - 比較対象2
 * @param timezone - ユーザーのタイムゾーン
 * @returns 同一日ならtrue
 */
export function tzIsSameDay(a: Date, b: Date, timezone: string): boolean {
  return (
    formatInTimeZone(a, timezone, 'yyyy-MM-dd') === formatInTimeZone(b, timezone, 'yyyy-MM-dd')
  );
}

/**
 * 指定 Date がユーザー TZ における「今日」かどうか
 *
 * date-fns の `isToday` はブラウザのローカル TZ を基準とするため、
 * ユーザーが設定した calendar timezone と OS TZ が異なる場合に
 * 「今日」のハイライトが 1 日ずれる問題が発生する。
 * カレンダー UI からはこの helper を使うこと。
 *
 * @param date - 判定対象（UTC Date）
 * @param timezone - ユーザーのタイムゾーン
 * @param now - 比較基準（テスト用）。省略時は現在時刻
 * @returns ユーザー TZ で今日と同じ日付なら true
 */
export function isTodayInTimezone(date: Date, timezone: string, now: Date = new Date()): boolean {
  return tzIsSameDay(date, now, timezone);
}

/**
 * 指定 Date がユーザー TZ における「今日より過去」かどうか（#2302）
 *
 * `yyyy-MM-dd` 形式の暦日キー同士を文字列比較する（ISO 形式なので
 * 辞書順比較がそのまま日付順になる）。`isTodayInTimezone` と同じ
 * `formatInTimeZone` ベースの手法で TZ 境界を揃える。
 *
 * @param date - 判定対象（UTC Date）
 * @param timezone - ユーザーのタイムゾーン
 * @param now - 比較基準（テスト用）。省略時は現在時刻
 */
export function isPastDayInTimezone(date: Date, timezone: string, now: Date = new Date()): boolean {
  return (
    formatInTimeZone(date, timezone, 'yyyy-MM-dd') < formatInTimeZone(now, timezone, 'yyyy-MM-dd')
  );
}

/** 指定 Date がユーザー TZ における「今日より未来」かどうか（`isPastDayInTimezone` 参照） */
export function isFutureDayInTimezone(
  date: Date,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return (
    formatInTimeZone(date, timezone, 'yyyy-MM-dd') > formatInTimeZone(now, timezone, 'yyyy-MM-dd')
  );
}

/**
 * 壁時計 Date から、指定 TZ でのその日の 00:00:00.000 を表す UTC ISO 文字列を返す。
 *
 * **`date` は `date-fns` のローカルフィールド演算（`setHours` / `startOfDay` / `addDays` 等）で
 * 作られた壁時計 Date を想定する**（instant ではない）。`toZonedTime` や `formatInTimeZone` /
 * `Intl.DateTimeFormat({ timeZone })` を `date` に直接掛けると、`date` を instant として
 * `timezone` へ再解釈してしまい、実行環境の system TZ と `timezone` が食い違う時に日付がずれる
 * （`external-event-day-selection.ts` と `useCalendarData.ts` で実際に発生した同型バグ、#2017）。
 * 正しい手順は `getDateKey(date)`（timezone なし、ローカルフィールド読み取り）で `date` が表す
 * 暦日をそのまま取り出し、その日の境界を `fromZonedTime` で `timezone` の instant へ変換すること。
 *
 * 壁時計 Date → TZ instant の変換はこの module（`@/lib/date/timezone`）に集約し、feature code
 * から `date-fns-tz` の `toZonedTime` を直接 import することは ESLint で禁止している
 * （`eslint.config.mjs` の `no-restricted-syntax`）。
 */
export function toTZStartISO(date: Date, timezone: string): string {
  const localDateStr = getDateKey(date);
  return fromZonedTime(new Date(`${localDateStr}T00:00:00`), timezone).toISOString();
}

/** 壁時計 Date から、指定 TZ でのその日の 23:59:59.999 を表す UTC ISO 文字列を返す（`toTZStartISO` 参照）。 */
export function toTZEndISO(date: Date, timezone: string): string {
  const localDateStr = getDateKey(date);
  return fromZonedTime(new Date(`${localDateStr}T23:59:59.999`), timezone).toISOString();
}

/** カレンダーの壁時計 Date（暦日）は instant に変換せず比較する。 */
export function isTodayWallDateInTimezone(
  date: Date,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return getDateKey(date) === getDateKey(now, timezone);
}

/** カレンダーの壁時計 Date が、ユーザー TZ の今日より前かを判定する。 */
export function isPastWallDateInTimezone(
  date: Date,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return getDateKey(date) < getDateKey(now, timezone);
}
