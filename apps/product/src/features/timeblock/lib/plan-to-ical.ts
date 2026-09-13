/**
 * Plan[] → iCalendar 文字列変換
 *
 * RFC 5545 準拠の VCALENDAR を生成。
 * Google Calendar / Apple Calendar などで購読可能。
 */

import { dayoptDomains } from '@dayopt/config';

/** `plans` 行のうち iCal に載せる列。列名は DB（`plans`）と同じにして詰め替えを持たない */
interface ICalPlan {
  id: string;
  title: string;
  note: string | null;
  start_at: string | null;
  end_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * iCalendar のテキスト値をエスケープする
 * RFC 5545 Section 3.3.11
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * ISO日時をiCalendar形式（UTC）に変換
 * 例: "2026-03-17T09:00:00+09:00" → "20260317T000000Z"
 */
function toICalDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * 長い行を75オクテットで折り返す（RFC 5545 Section 3.1）
 */
function foldLine(line: string): string {
  const MAX_OCTETS = 75;
  if (line.length <= MAX_OCTETS) return line;

  const parts: string[] = [line.slice(0, MAX_OCTETS)];
  let pos = MAX_OCTETS;
  while (pos < line.length) {
    parts.push(' ' + line.slice(pos, pos + MAX_OCTETS - 1));
    pos += MAX_OCTETS - 1;
  }
  return parts.join('\r\n');
}

/**
 * Plan 配列から iCalendar 文字列を生成
 */
export function plansToICal(plans: ICalPlan[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dayopt//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Dayopt',
  ];

  for (const plan of plans) {
    if (!plan.start_at || !plan.end_at) continue;

    // SUMMARY は Plan のタイトル。#2162 cutover 以降に作られた Plan は tag_id が
    // NULL なので旧実装でも実質 title へ落ちており、ここでの一本化は現行挙動への
    // 収束（cutover 前の古い Plan だけ、旧タグ名 → タイトル へ変わる）。
    const summary = plan.title;
    const uid = `${plan.id}@${dayoptDomains.marketing}`;

    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${uid}`));
    lines.push(`DTSTART:${toICalDateTime(plan.start_at)}`);
    lines.push(`DTEND:${toICalDateTime(plan.end_at)}`);
    lines.push(foldLine(`SUMMARY:${escapeICalText(summary)}`));

    if (plan.note) {
      lines.push(foldLine(`DESCRIPTION:${escapeICalText(plan.note)}`));
    }

    if (plan.created_at) {
      lines.push(`DTSTAMP:${toICalDateTime(plan.created_at)}`);
    }

    if (plan.updated_at) {
      lines.push(`LAST-MODIFIED:${toICalDateTime(plan.updated_at)}`);
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}
