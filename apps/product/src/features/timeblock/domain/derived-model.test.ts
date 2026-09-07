import { aggregate, overlappingRecords, type DerivedBlock } from '@/lib/time';
import { describe, expect, it } from 'vitest';

const now = new Date('2026-09-07T23:00:00Z');
const period = { startAt: '2026-09-07T00:00:00Z', endAt: '2026-09-14T00:00:00Z', timezone: 'UTC' };
function block(
  kind: DerivedBlock['kind'],
  start: string,
  end: string,
  activityId: string | null = 'a',
): DerivedBlock {
  return {
    id: kind,
    kind,
    start,
    end,
    activityId,
    memo: null,
    fulfillment: 'high',
    live: false,
    source: 'manual',
  };
}
const plan = block('plan', '2026-09-07T09:00:00Z', '2026-09-07T10:00:00Z');
const record = block('rec', '2026-09-07T09:05:00Z', '2026-09-07T10:35:00Z');
const ratio = (blocks: DerivedBlock[], activityId: string | null = 'a') => {
  const totals = aggregate(period, activityId, blocks, now);
  return totals.plannedPastMinutes >= 15
    ? totals.recordedMinutes / totals.plannedPastMinutes
    : null;
};

describe('independent plan and record derivation', () => {
  it('derives overlap and a 150% period ratio without linking records', () => {
    expect(overlappingRecords(plan, [plan, record], now)).toEqual([record]);
    expect(ratio([plan, record])).toBe(1.5);
  });
  it('moving the record changes temporal context, not the same-week ratio', () => {
    for (const day of ['07', '08']) {
      const moved = {
        ...record,
        start: `2026-09-${day}T11:00:00Z`,
        end: `2026-09-${day}T12:30:00Z`,
      };
      expect(overlappingRecords(plan, [moved], now)).toEqual([]);
      expect(ratio([plan, moved])).toBe(1.5);
    }
    expect(
      ratio([plan, { ...record, start: '2026-09-14T09:00:00Z', end: '2026-09-14T10:30:00Z' }]),
    ).toBe(0);
  });
  it('attributes records to their own activity', () => {
    const changed = { ...record, activityId: 'b' };
    expect(ratio([plan, changed])).toBe(0);
    expect(ratio([plan, changed], 'b')).toBeNull();
    expect(overlappingRecords(plan, [changed], now)).toEqual([]);
  });
  it('retains independent totals after either row is removed', () => {
    expect(aggregate(period, 'a', [record], now).recordedMinutes).toBe(90);
    expect(aggregate(period, 'a', [plan], now).plannedMinutes).toBe(60);
  });
  it('clips in-progress plans to now and excludes future plans from planPast', () => {
    expect(
      aggregate(period, 'a', [plan], new Date('2026-09-07T09:30:00Z')).plannedPastMinutes,
    ).toBe(30);
    expect(aggregate(period, 'a', [plan], new Date(plan.start)).plannedPastMinutes).toBe(0);
    expect(
      aggregate(period, 'a', [plan], new Date('2026-09-07T08:00:00Z')).plannedPastMinutes,
    ).toBe(0);
  });
  it('excludes ghosts from overlap and every aggregate', () => {
    const ghost = { ...record, kind: 'gh' as const };
    expect(overlappingRecords(plan, [ghost], now)).toEqual([]);
    expect(aggregate(period, 'a', [plan, ghost], now)).toEqual(aggregate(period, 'a', [plan], now));
  });
  it('uses now as the end of live records', () => {
    const live = { ...record, start: plan.start, live: true };
    const asOf = new Date('2026-09-07T09:20:00Z');
    expect(aggregate(period, 'a', [live], asOf).recordedMinutes).toBe(20);
    expect(overlappingRecords(plan, [live], asOf)).toEqual([live]);
  });
  it('requires fifteen elapsed minutes, excludes adjacent intervals, and groups null activity', () => {
    for (const [start, count] of [
      ['09:45:00', 1],
      ['09:45:01', 0],
      ['10:00:00', 0],
    ] as const) {
      expect(
        overlappingRecords(plan, [{ ...record, start: `2026-09-07T${start}Z` }], now),
      ).toHaveLength(count);
    }
    expect(
      overlappingRecords({ ...plan, activityId: null }, [{ ...record, activityId: null }], now),
    ).toHaveLength(1);
  });
  it('partitions midnight crossings without double counting records or fulfillment', () => {
    const overnight = { ...record, start: '2026-09-07T23:30:00Z', end: '2026-09-08T01:00:00Z' };
    const totals = aggregate(period, 'a', [overnight], now);
    expect(totals.byDay).toEqual({ '2026-09-07': 30, '2026-09-08': 60 });
    expect(totals.recordedMinutes).toBe(90);
    expect(totals.recordBoxes).toBe(1);
    expect(totals.fulfillment.high).toBe(1);
    expect(totals.medianBoxMinutes).toBe(90);
  });
  it('preserves actual elapsed duration across DST', () => {
    const dstPeriod = {
      startAt: '2026-03-08T05:00:00Z',
      endAt: '2026-03-09T04:00:00Z',
      timezone: 'America/New_York',
    };
    const totals = aggregate(
      dstPeriod,
      'a',
      [block('rec', dstPeriod.startAt, dstPeriod.endAt)],
      now,
    );
    expect(totals.byDay).toEqual({ '2026-03-08': 23 * 60 });
    expect(totals.recordedMinutes).toBe(23 * 60);
  });
});
