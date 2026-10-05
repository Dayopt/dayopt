import { describe, expect, it, vi } from 'vitest';

import { createActivitySummaryService } from './activity-summary-service';

import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

const USER_ID = 'user-1';
const ACTIVITY_ID = 'activity-1';
const NOW = new Date('2026-09-04T03:00:00.000Z'); // 12:00 in Tokyo

interface RecordSeed {
  id: string;
  user_id: string;
  activity_id: string;
  deleted_at: string | null;
  title: string;
  start_at: string;
  end_at: string;
  source: string;
}

function createFakeClient(records: RecordSeed[]): SupabaseClient<Database> {
  return {
    from: () => {
      let current = records as unknown as Record<string, unknown>[];
      let from = 0;
      let to = current.length - 1;
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          current = current.filter((row) => row[column] === value);
          return query;
        },
        is: (column: string, value: unknown) => {
          current = current.filter((row) => row[column] === value);
          return query;
        },
        lt: (column: string, value: string) => {
          current = current.filter((row) => Date.parse(String(row[column])) < Date.parse(value));
          return query;
        },
        gt: (column: string, value: string) => {
          current = current.filter((row) => Date.parse(String(row[column])) > Date.parse(value));
          return query;
        },
        order: (column: string) => {
          current = [...current].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          return query;
        },
        range: (start: number, end: number) => {
          from = start;
          to = end;
          return query;
        },
        then: (resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          resolve({ data: current.slice(from, to + 1), error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient<Database>;
}

function tokyo(day: string, time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCHours((hour ?? 0) - 9, minute ?? 0, 0, 0);
  return date.toISOString();
}

function record(
  id: string,
  day: string,
  start: string,
  end: string,
  overrides: Partial<RecordSeed> = {},
): RecordSeed {
  return {
    id,
    user_id: USER_ID,
    activity_id: ACTIVITY_ID,
    deleted_at: null,
    title: id,
    start_at: tokyo(day, start),
    end_at: tokyo(day, end),
    source: 'manual',
    ...overrides,
  };
}

describe('createActivitySummaryService', () => {
  it('aggregates all trailing local-day records, caps displayed details, and excludes future records', async () => {
    const recent = Array.from({ length: 205 }, (_, index) =>
      record(`r${String(index).padStart(3, '0')}`, '2026-09-04', '10:00', '10:30', {
        start_at: new Date(Date.parse(tokyo('2026-09-04', '10:00')) - index * 60_000).toISOString(),
        end_at: new Date(Date.parse(tokyo('2026-09-04', '10:30')) - index * 60_000).toISOString(),
      }),
    );
    const boundary = record('boundary', '2026-08-05', '23:30', '00:30');
    boundary.end_at = tokyo('2026-08-06', '00:30');
    const outside = record('outside', '2026-08-05', '10:00', '13:00');
    const future = record('future', '2026-09-04', '13:00', '14:00');
    const migrated = record('migrated', '2026-09-03', '10:00', '14:00', {
      source: 'auto_migrated',
    });
    const otherUser = record('other-user', '2026-09-03', '10:00', '12:00', {
      user_id: 'user-2',
    });
    const otherActivity = record('other-activity', '2026-09-03', '10:00', '12:00', {
      activity_id: 'activity-2',
    });
    const service = createActivitySummaryService(
      createFakeClient([...recent, boundary, outside, future, migrated, otherUser, otherActivity]),
    );

    const result = await service.getActivitySummary(
      USER_ID,
      { activityId: ACTIVITY_ID, timezone: 'Asia/Tokyo' },
      NOW,
    );

    expect(result.startDate).toBe('2026-08-06');
    expect(result.endDate).toBe('2026-09-04');
    expect(result.recordedMinutes).toBe(205 * 30 + 30 + 240);
    expect(result.medianBoxMinutes).toBe(30);
    expect(result.totalRecordCount).toBe(207);
    expect(result.records).toHaveLength(200);
    expect(result.records[0]?.id).toBe('r000');
    expect(result.records.map((row) => row.id)).not.toContain('outside');
    expect(result.records.map((row) => row.id)).not.toContain('future');
    expect(result.records.map((row) => row.id)).not.toContain('other-user');
    expect(result.records.map((row) => row.id)).not.toContain('other-activity');
  });

  it('returns no median when every record is auto-migrated', async () => {
    const service = createActivitySummaryService(
      createFakeClient([
        record('migrated', '2026-09-03', '10:00', '11:00', { source: 'auto_migrated' }),
      ]),
    );

    const result = await service.getActivitySummary(
      USER_ID,
      { activityId: ACTIVITY_ID, timezone: 'Asia/Tokyo' },
      NOW,
    );

    expect(result.recordedMinutes).toBe(60);
    expect(result.medianBoxMinutes).toBeNull();
  });
});
