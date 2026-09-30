/**
 * テンプレート（型）の錨位置（local midnight からの分）を、適用先の暦日 + ユーザー
 * timezone の instant へ解決する pure function（#2567）。
 *
 * 保存形式は `anchor_minute`（0..1439）。比率で持つと DST の 23h / 25h 日で錨がずれる
 * ため分で持ち、適用時のユーザー timezone の**壁時計**として解釈する。保存元の
 * timezone は持たないので、timezone を変えた後は新 timezone の同じ壁時計へ追従する。
 *
 * DST policy はここで固定する（date-fns-tz の `fromZonedTime` は gap を後方へ送り、
 * fold は実行環境の system TZ で結果が変わるため契約として使えない — 実測 2026-09-05）:
 *
 * - **gap**（存在しない壁時計。例: America/New_York 2025-03-09 02:30）: DST 差分だけ
 *   **前方**へ送る（02:30 → 03:30 EDT）
 * - **fold**（2 回ある壁時計。例: 2025-11-02 01:30）: **早い方**の instant を選ぶ（EDT 側）
 * - end は `start instant + 実経過分` で作り、壁時計ではなく実経過時間を守る
 *
 * `toZonedTime` は使わない（壁時計 Date への誤適用で日付がずれる bug class、#2017）。
 * offset 計算は `getTimezoneOffset`、round-trip 検査は `formatInTimeZone` で行う。
 */

import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz';

import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/date/constants';

export const MINUTES_PER_DAY = 1440;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate the Gregorian day without allowing Date's overflow normalization. */
export function isValidTemplateDateKey(dateKey: string): boolean {
  if (!DATE_KEY_PATTERN.test(dateKey)) return false;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

function parseDateKey(dateKey: string): Date {
  if (!isValidTemplateDateKey(dateKey)) throw new RangeError(`Invalid date key: ${dateKey}`);
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `dateKey` の翌日（暦日演算は UTC で行う。壁時計フィールドしか触らないので TZ 非依存）。 */
export function nextDateKey(dateKey: string): string {
  const next = parseDateKey(dateKey);
  next.setUTCDate(next.getUTCDate() + 1);
  const iso = next.toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

/**
 * 錨位置を instant へ解決する。
 *
 * 壁時計を「UTC のふりをした ms」として置き、その前後 1 日の offset 候補で instant を作り、
 * `formatInTimeZone` で元の壁時計へ戻るものだけを採る。戻るものが複数あれば fold なので
 * 早い方、1 つも無ければ gap なので遷移前 offset で作った instant（= 前方へ送った時刻）を返す。
 */
export function anchorMinuteToInstant(
  dateKey: string,
  anchorMinute: number,
  timezone: string,
): Date {
  if (!Number.isInteger(anchorMinute) || anchorMinute < 0 || anchorMinute >= MINUTES_PER_DAY) {
    throw new RangeError(`Invalid anchor minute: ${anchorMinute}`);
  }
  const wallAsUtc = parseDateKey(dateKey);
  const hours = Math.floor(anchorMinute / 60);
  const minutes = anchorMinute % 60;
  wallAsUtc.setUTCHours(hours, minutes);
  const wallAsUtcMs = wallAsUtc.getTime();
  const expectedWall = `${dateKey} ${pad2(hours)}:${pad2(minutes)}`;

  const offsets = new Set<number>();
  for (const probe of [wallAsUtcMs - MS_PER_DAY, wallAsUtcMs, wallAsUtcMs + MS_PER_DAY]) {
    offsets.add(getTimezoneOffset(timezone, new Date(probe)));
  }
  // probe で得た offset で一度引いた instant を再度 probe する（半端な offset の TZ を拾う）
  for (const offset of [...offsets]) {
    offsets.add(getTimezoneOffset(timezone, new Date(wallAsUtcMs - offset)));
  }

  const candidates = [...offsets]
    .map((offset) => wallAsUtcMs - offset)
    .filter((instant) => formatInTimeZone(instant, timezone, 'uuuu-MM-dd HH:mm') === expectedWall)
    .sort((a, b) => a - b);

  const earliest = candidates[0];
  if (earliest !== undefined) return new Date(earliest);

  // gap: 遷移前（前日側）の offset で作ると、遷移後の壁時計では DST 差分だけ前方に見える
  const offsetBefore = getTimezoneOffset(timezone, new Date(wallAsUtcMs - MS_PER_DAY));
  return new Date(wallAsUtcMs - offsetBefore);
}

/** `dateKey` の翌日 00:00 の instant（その日の終わり。半開区間 `[start, end)` の end 側）。 */
export function dayEndInstant(dateKey: string, timezone: string): Date {
  return anchorMinuteToInstant(nextDateKey(dateKey), 0, timezone);
}

/** instant を timezone の暦日キー（yyyy-MM-dd）へ。 */
export function instantToDateKey(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, 'uuuu-MM-dd');
}

/** instant を timezone の壁時計で見た「local midnight からの分」へ。 */
export function instantToAnchorMinute(instant: Date, timezone: string): number {
  const [hours, minutes] = formatInTimeZone(instant, timezone, 'HH:mm').split(':').map(Number);
  return (hours as number) * 60 + (minutes as number);
}

/** 2 instant の差を分で（`end - start`）。 */
export function minutesBetweenInstants(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MS_PER_MINUTE;
}
