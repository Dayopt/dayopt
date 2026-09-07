import { describe, expect, it } from 'vitest';
import {
  aggregateActivityEstimationFactors,
  projectActualMinutes,
} from './activity-estimation-factor';
import { toDerivedBlock } from './derived-model';

it('uses independent total durations and requires three plans', () => {
  const period = {
    startAt: '2026-09-01T00:00:00Z',
    endAt: '2026-10-01T00:00:00Z',
    timezone: 'UTC',
  };
  const plans = [1, 2, 3].map((day) =>
    toDerivedBlock(
      {
        id: String(day),
        activity_id: 'a',
        start_at: `2026-09-0${day}T09:00:00Z`,
        end_at: `2026-09-0${day}T10:00:00Z`,
      },
      'plan',
    ),
  );
  const record = toDerivedBlock(
    { id: 'r', activity_id: 'a', start_at: '2026-09-04T09:00:00Z', end_at: '2026-09-04T13:30:00Z' },
    'rec',
  );
  const now = new Date(period.endAt);
  expect(aggregateActivityEstimationFactors([...plans, record], period, now)).toEqual([
    { activityId: 'a', factor: 1.5, sampleCount: 3 },
  ]);
  expect(aggregateActivityEstimationFactors([plans[0]!, record], period, now)).toEqual([]);
});

describe('projectActualMinutes', () => {
  it('係数を draft の予定時間に掛けて 5 分刻みに丸める', () => {
    expect(projectActualMinutes(1.5, 30)).toBe(45);
    expect(projectActualMinutes(1, 60)).toBe(60);
    expect(projectActualMinutes(0.5, 60)).toBe(30);
  });

  it('端数は最も近い 5 分へ寄せる', () => {
    // 1.1 * 30 = 33 → 35
    expect(projectActualMinutes(1.1, 30)).toBe(35);
    // 1.05 * 30 = 31.5 → 30
    expect(projectActualMinutes(1.05, 30)).toBe(30);
  });

  it('0 分と表示しないよう下限を 5 分にする', () => {
    expect(projectActualMinutes(0.01, 15)).toBe(5);
    expect(projectActualMinutes(0, 60)).toBe(5);
  });
});
