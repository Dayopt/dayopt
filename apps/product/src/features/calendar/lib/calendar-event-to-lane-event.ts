/**
 * `CalendarDisplayEvent`（Step 8 の time model 射影）から TwoLane カード用の
 * `PlanEvent` / `RecordEvent` 表示型へ変換するアダプタ。
 *
 * `useCalendarData` は Plan / Record を独立した CalendarDisplayEvent に変換する。
 * ここでは表示中の全イベントから、同じアクティビティで15分以上重なる Record の
 * 有無だけを読み取り時に導出する。
 */

import { type PlanEvent, type PlanEventStatus, type RecordEvent } from '@/features/timeblock';
import { overlappingRecords, type DerivedBlock } from '@/lib/time';

import type { CalendarDisplayEvent } from '../types/calendar.types';

function resolvePlanEventStatus(
  event: CalendarDisplayEvent,
  hasRecords: boolean,
  now: Date,
): PlanEventStatus {
  if (hasRecords) return 'with-records';
  const endDate = event.endDate ?? event.displayEndDate;
  const startDate = event.startDate ?? event.displayStartDate;
  if (endDate && endDate.getTime() <= now.getTime()) return 'unrecorded';
  if (startDate && startDate.getTime() <= now.getTime()) return 'active';
  return 'upcoming';
}

/** kind='plan' の CalendarDisplayEvent を PlanLaneCard 用の PlanEvent へ変換する */
export function calendarEventToPlanEvent(
  event: CalendarDisplayEvent,
  allEvents: ReadonlyArray<CalendarDisplayEvent>,
  now: Date = new Date(),
): PlanEvent {
  const project = (item: CalendarDisplayEvent): DerivedBlock => ({
    id: item.id,
    kind: item.kind === 'record' ? 'rec' : 'plan',
    activityId: item.activityId ?? null,
    start: (item.startDate ?? item.displayStartDate).toISOString(),
    end: (item.endDate ?? item.displayEndDate).toISOString(),
    memo: item.description ?? null,
    fulfillment: null,
    live: false,
    source: 'manual',
  });
  const hasRecords = overlappingRecords(project(event), allEvents.map(project), now).length > 0;
  return {
    id: event.id,
    title: event.title,
    note: event.description ?? null,
    activityId: event.activityId ?? null,
    startDate: event.startDate ?? event.displayStartDate,
    endDate: event.endDate ?? event.displayEndDate,
    displayStartDate: event.displayStartDate,
    displayEndDate: event.displayEndDate,
    duration: event.duration,
    status: resolvePlanEventStatus(event, hasRecords, now),
  };
}

/** kind='record' の CalendarDisplayEvent を RecordLaneCard 用の RecordEvent へ変換する */
export function calendarEventToRecordEvent(event: CalendarDisplayEvent): RecordEvent {
  return {
    id: event.id,
    title: event.title,
    note: event.description ?? null,
    activityId: event.activityId ?? null,
    startDate: event.startDate ?? event.displayStartDate,
    endDate: event.endDate ?? event.displayEndDate,
    displayStartDate: event.displayStartDate,
    displayEndDate: event.displayEndDate,
    duration: event.duration,
  };
}
