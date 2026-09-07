import { describe, expect, it } from 'vitest';

import { deriveTemplateBlocksFromDay } from './plan-template-compose';

interface SourceOverrides {
  kind?: 'plan' | 'record';
  activityId?: string | null;
  title?: string;
  startDate?: Date | null;
  plannedStartDate?: Date | null;
}

function source(startIso: string, overrides: SourceOverrides = {}) {
  const start = new Date(startIso);
  return {
    kind: 'plan' as const,
    activityId: 'a1',
    title: 'Work',
    startDate: start,
    plannedStartDate: start,
    ...overrides,
  };
}

describe('deriveTemplateBlocksFromDay', () => {
  it('その暦日に start が入る Plan だけを錨順に取り出す（Asia/Tokyo）', () => {
    const blocks = deriveTemplateBlocksFromDay(
      [
        source('2026-09-05T03:00:00Z', { title: 'Lunch', activityId: null }),
        source('2026-09-05T00:00:00Z', { title: 'Focus' }),
        source('2026-09-05T02:00:00Z', { kind: 'record', title: 'Record' }),
        // 前日 23:30 JST 開始（14:30Z）は対象外
        source('2026-09-04T14:30:00Z', { title: 'Yesterday' }),
        // 翌日 00:00 JST（15:00Z）は対象外
        source('2026-09-05T15:00:00Z', { title: 'Tomorrow' }),
      ],
      '2026-09-05',
      'Asia/Tokyo',
    );
    expect(blocks).toEqual([
      { activityId: 'a1', title: 'Focus', anchorMinute: 9 * 60 },
      { activityId: null, title: 'Lunch', anchorMinute: 12 * 60 },
    ]);
  });

  it('同じ錨に 2 件あれば開始が早い方だけ残す', () => {
    const blocks = deriveTemplateBlocksFromDay(
      [
        source('2026-09-05T09:00:40Z', { title: 'Second' }),
        source('2026-09-05T09:00:10Z', { title: 'First' }),
      ],
      '2026-09-05',
      'UTC',
    );
    expect(blocks.map((block) => block.title)).toEqual(['First']);
  });

  it('title を trim し、空になる Plan は除く', () => {
    const blocks = deriveTemplateBlocksFromDay(
      [
        source('2026-09-05T09:00:00Z', { title: '  Deep work  ' }),
        source('2026-09-05T10:00:00Z', { title: '   ' }),
      ],
      '2026-09-05',
      'UTC',
    );
    expect(blocks).toEqual([{ activityId: 'a1', title: 'Deep work', anchorMinute: 540 }]);
  });

  it('start が無い行は無視し、空の日は空配列', () => {
    expect(
      deriveTemplateBlocksFromDay(
        [source('2026-09-05T09:00:00Z', { startDate: null, plannedStartDate: null })],
        '2026-09-05',
        'UTC',
      ),
    ).toEqual([]);
    expect(deriveTemplateBlocksFromDay([], '2026-09-05', 'UTC')).toEqual([]);
  });
});
