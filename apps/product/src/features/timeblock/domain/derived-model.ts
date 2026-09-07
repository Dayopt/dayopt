import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** Read model only. Ownership and soft deletion are enforced by the fetcher. */
export interface DerivedBlock {
  id: string;
  kind: 'plan' | 'rec' | 'gh';
  activityId: string | null;
  start: string;
  end: string;
  memo: string | null;
  fulfillment: 'low' | 'medium' | 'high' | null;
  live: boolean;
  source: string;
}

export interface DerivedPeriod {
  startAt: string;
  endAt: string;
  timezone: string;
}

function effectiveEnd(block: DerivedBlock, now: Date): number {
  return block.kind === 'rec' && block.live ? now.getTime() : Date.parse(block.end);
}

function intersection(start: number, end: number, lower: number, upper: number): number {
  return Math.max(0, Math.min(end, upper) - Math.max(start, lower)) / 60_000;
}

/** Temporal context, never a persisted association or a completion claim. */
export function overlappingRecords(
  plan: DerivedBlock,
  blocks: readonly DerivedBlock[],
  now: Date,
): DerivedBlock[] {
  if (plan.kind !== 'plan') return [];
  return blocks.filter(
    (block) =>
      block.kind === 'rec' &&
      block.activityId === plan.activityId &&
      intersection(
        Date.parse(block.start),
        effectiveEnd(block, now),
        Date.parse(plan.start),
        Date.parse(plan.end),
      ) >= 15,
  );
}

/** Period-clipped elapsed durations. Day partitioning never splits stored records. */
export function aggregate(
  period: DerivedPeriod,
  activityId: string | null,
  blocks: readonly DerivedBlock[],
  now: Date,
) {
  const lower = Date.parse(period.startAt);
  const upper = Date.parse(period.endAt);
  const result = {
    recordedMinutes: 0,
    plannedMinutes: 0,
    plannedPastMinutes: 0,
    plannedPastBoxes: 0,
    recordBoxes: 0,
    records: [] as { block: DerivedBlock; minutes: number }[],
    fulfillment: { low: 0, medium: 0, high: 0 },
    byDay: {} as Record<string, number>,
    medianBoxMinutes: null as number | null,
  };
  for (const block of blocks) {
    if (block.kind === 'gh' || block.activityId !== activityId) continue;
    const start = Date.parse(block.start);
    const end = effectiveEnd(block, now);
    const minutes = intersection(start, end, lower, upper);
    if (!(minutes > 0)) continue;
    if (block.kind === 'plan') {
      result.plannedMinutes += minutes;
      const past = intersection(start, Math.min(end, now.getTime()), lower, upper);
      result.plannedPastMinutes += past;
      if (start <= now.getTime()) result.plannedPastBoxes += 1;
      continue;
    }
    result.recordedMinutes += minutes;
    result.recordBoxes += 1;
    result.records.push({ block, minutes });
    if (block.fulfillment !== null) result.fulfillment[block.fulfillment] += 1;
    let cursor = Math.max(start, lower);
    const limit = Math.min(end, upper);
    while (cursor < limit) {
      const day = formatInTimeZone(cursor, period.timezone, 'yyyy-MM-dd');
      const nextDay = addDays(new Date(`${day}T12:00:00Z`), 1)
        .toISOString()
        .slice(0, 10);
      const boundary = fromZonedTime(`${nextDay}T00:00:00`, period.timezone).getTime();
      const sliceEnd = Math.min(limit, boundary);
      if (!(sliceEnd > cursor)) throw new RangeError('Invalid zoned day boundary');
      result.byDay[day] = (result.byDay[day] ?? 0) + (sliceEnd - cursor) / 60_000;
      cursor = sliceEnd;
    }
  }
  const lengths = result.records.map((record) => record.minutes).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  if (lengths.length > 0) {
    result.medianBoxMinutes =
      lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  }
  return result;
}

/** Shared projection for DB readers; it deliberately cannot carry relation fields. */
export function toDerivedBlock(
  row: {
    id: string;
    activity_id: string | null;
    start_at: string;
    end_at: string;
    note?: string | null;
    fulfillment?: string | null;
    source?: string;
  },
  kind: 'plan' | 'rec',
): DerivedBlock {
  const fulfillment = row.fulfillment;
  return {
    id: row.id,
    kind,
    activityId: row.activity_id,
    start: row.start_at,
    end: row.end_at,
    memo: row.note ?? null,
    fulfillment:
      fulfillment === 'low' || fulfillment === 'medium' || fulfillment === 'high'
        ? fulfillment
        : null,
    live: false,
    source: row.source ?? 'manual',
  };
}
