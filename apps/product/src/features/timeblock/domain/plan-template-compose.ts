/**
 * 「生きた日」からテンプレート（型）の組成を取り出す pure function（#2567）。
 *
 * 作成は常に表示中の日からのみ（白紙から設計させない — 空フォルダ病の予防）。
 * 保存対象の境界:
 *
 * - `kind === 'plan'` の Plan だけ。Record・外部カレンダーの ghost は対象外
 * - **start がその暦日に入る** Plan だけ。前日から跨ぐ Plan は錨がこの日に無いので対象外
 * - 錨位置は start をユーザー timezone の壁時計で見た「local midnight からの分」
 * - 同じ錨に 2 件以上ある時は開始が早い方だけ残す（`UNIQUE (template_id, anchor_minute)` の
 *   DB 制約は最終防波堤で、保存全体を失敗させない）
 *
 * 入力は calendar が既に持っている表示用射影 `CalendarEvent`（生の Plan 行を取り直さない）。
 * 使うのは instant の `startDate`（`displayStartDate` は壁時計へ変換済みなので使わない）。
 */

import type { CalendarEvent } from '../types/calendar-event';

import { instantToAnchorMinute, instantToDateKey } from './plan-template-anchor';

interface TemplateBlockDraft {
  activityId: string | null;
  title: string;
  anchorMinute: number;
}

type ComposeSource = Pick<
  CalendarEvent,
  'kind' | 'activityId' | 'title' | 'startDate' | 'plannedStartDate'
>;

export function deriveTemplateBlocksFromDay(
  events: ReadonlyArray<ComposeSource>,
  dateKey: string,
  timezone: string,
): TemplateBlockDraft[] {
  const candidates: Array<TemplateBlockDraft & { startMs: number }> = [];
  for (const event of events) {
    if (event.kind !== 'plan') continue;
    const start = event.plannedStartDate ?? event.startDate;
    if (!start) continue;
    if (instantToDateKey(start, timezone) !== dateKey) continue;
    const title = event.title.trim();
    if (title.length === 0) continue;
    candidates.push({
      activityId: event.activityId ?? null,
      title,
      anchorMinute: instantToAnchorMinute(start, timezone),
      startMs: start.getTime(),
    });
  }

  candidates.sort((a, b) => a.startMs - b.startMs);
  const seen = new Set<number>();
  const blocks: TemplateBlockDraft[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.anchorMinute)) continue;
    seen.add(candidate.anchorMinute);
    blocks.push({
      activityId: candidate.activityId,
      title: candidate.title,
      anchorMinute: candidate.anchorMinute,
    });
  }
  return blocks;
}
