import { describe, expect, it } from 'vitest';

import type { TimedTimeblock } from '../types/timeblock.types';

import {
  calculateMaxConcurrent,
  calculateTimeblockLayouts,
  calculateTimeblockPosition,
  detectOverlapGroups,
  findOverlapGroups,
  isOverlapping,
} from './layout';

// ========================================
// テストヘルパー
// ========================================

function createTimedTimeblock(
  overrides: Partial<TimedTimeblock> & { start: Date; end: Date },
): TimedTimeblock {
  return {
    id: 'test-1',
    title: 'Test Timeblock',
    startDate: overrides.start,
    endDate: overrides.end,
    displayStartDate: overrides.start,
    displayEndDate: overrides.end,
    duration: (overrides.end.getTime() - overrides.start.getTime()) / 60000,
    isMultiDay: false,
    color: '',
    kind: 'plan',
    ...overrides,
  } as TimedTimeblock;
}

// ========================================
// calculateTimeblockLayouts
// ========================================

describe('calculateTimeblockLayouts', () => {
  it('空配列で空のレイアウトを返す', () => {
    expect(calculateTimeblockLayouts([])).toEqual([]);
  });

  it('単一タイムブロックはfull widthで配置', () => {
    const timeblock = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const layouts = calculateTimeblockLayouts([timeblock]);

    expect(layouts).toHaveLength(1);
    expect(layouts[0]!.column).toBe(0);
    expect(layouts[0]!.totalColumns).toBe(1);
    expect(layouts[0]!.width).toBe(100);
    expect(layouts[0]!.left).toBe(0);
  });

  it('重複する2タイムブロックは50%ずつに分割', () => {
    const timeblock1 = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const timeblock2 = createTimedTimeblock({
      id: 'b',
      start: new Date('2026-01-15T10:30:00'),
      end: new Date('2026-01-15T11:30:00'),
    });
    const layouts = calculateTimeblockLayouts([timeblock1, timeblock2]);

    expect(layouts).toHaveLength(2);
    expect(layouts[0]!.totalColumns).toBe(2);
    expect(layouts[1]!.totalColumns).toBe(2);
    expect(layouts[0]!.width).toBe(50);
    expect(layouts[1]!.width).toBe(50);
  });

  it('planned の未実行前半 gap に作った unplanned は右側に横割りする', () => {
    const unplannedGapRecord = createTimedTimeblock({
      id: 'gap-record',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T10:30:00'),
      kind: 'record',
    });
    const planned = createTimedTimeblock({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });

    const layouts = calculateTimeblockLayouts([unplannedGapRecord, planned]);
    const plannedLayout = layouts.find((layout) => layout.timeblock.id === 'planned');
    const recordLayout = layouts.find((layout) => layout.timeblock.id === 'gap-record');

    expect(plannedLayout).toMatchObject({ column: 0, left: 0, width: 50, totalColumns: 2 });
    expect(recordLayout).toMatchObject({ column: 1, left: 50, width: 50, totalColumns: 2 });
  });

  it('planned の actual 範囲に重なる unplanned は従来通り横割りする', () => {
    const planned = createTimedTimeblock({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    const overlappingRecord = createTimedTimeblock({
      id: 'overlap-record',
      start: new Date('2026-01-15T10:15:00'),
      end: new Date('2026-01-15T10:45:00'),
      kind: 'record',
    });

    const layouts = calculateTimeblockLayouts([planned, overlappingRecord]);

    expect(layouts).toHaveLength(2);
    layouts.forEach((layout) => {
      expect(layout.totalColumns).toBe(2);
      expect(layout.width).toBe(50);
    });
  });

  it('unplanned が少し早く始まっても planned を左、unplanned を右に配置する', () => {
    const unplanned = createTimedTimeblock({
      id: 'unplanned',
      start: new Date('2026-01-15T09:45:00'),
      end: new Date('2026-01-15T10:15:00'),
      kind: 'record',
    });
    const planned = createTimedTimeblock({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });

    const layouts = calculateTimeblockLayouts([unplanned, planned]);
    const plannedLayout = layouts.find((layout) => layout.timeblock.id === 'planned');
    const unplannedLayout = layouts.find((layout) => layout.timeblock.id === 'unplanned');

    expect(plannedLayout).toMatchObject({ column: 0, left: 0, width: 50, totalColumns: 2 });
    expect(unplannedLayout).toMatchObject({ column: 1, left: 50, width: 50, totalColumns: 2 });
  });

  it('重複しない2タイムブロックは各自full width', () => {
    const timeblock1 = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const timeblock2 = createTimedTimeblock({
      id: 'b',
      start: new Date('2026-01-15T12:00:00'),
      end: new Date('2026-01-15T13:00:00'),
    });
    const layouts = calculateTimeblockLayouts([timeblock1, timeblock2]);

    expect(layouts).toHaveLength(2);
    layouts.forEach((layout) => {
      expect(layout.totalColumns).toBe(1);
      expect(layout.width).toBe(100);
    });
  });

  it('同一時刻のタイムブロックはID順で配置', () => {
    const planned = createTimedTimeblock({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    const laterTimeblock = createTimedTimeblock({
      id: 'later-timeblock',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    // 後発タイムブロックを先に渡しても、早い方がcolumn 0になるべき
    const layouts = calculateTimeblockLayouts([laterTimeblock, planned]);

    const plannedLayout = layouts.find((l) => l.timeblock.id === 'planned');
    const laterLayout = layouts.find((l) => l.timeblock.id === 'later-timeblock');

    expect(plannedLayout!.column).toBe(1);
    expect(laterLayout!.column).toBe(0);
  });
});

// ========================================
// findOverlapGroups
// ========================================

describe('findOverlapGroups', () => {
  it('重複するタイムブロックをグループ化', () => {
    const timeblocks = [
      createTimedTimeblock({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedTimeblock({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
      createTimedTimeblock({
        id: 'c',
        start: new Date('2026-01-15T14:00'),
        end: new Date('2026-01-15T15:00'),
      }),
    ];
    const groups = findOverlapGroups(timeblocks);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.timeblocks).toHaveLength(2);
    expect(groups[1]!.timeblocks).toHaveLength(1);
  });
});

// ========================================
// isOverlapping
// ========================================

describe('isOverlapping', () => {
  it('時間が重なるタイムブロックはtrue', () => {
    const a = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedTimeblock({
      id: 'b',
      start: new Date('2026-01-15T10:30'),
      end: new Date('2026-01-15T11:30'),
    });
    expect(isOverlapping(a, b)).toBe(true);
  });

  it('接触のみ（endとstartが同時刻）はfalse', () => {
    const a = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedTimeblock({
      id: 'b',
      start: new Date('2026-01-15T11:00'),
      end: new Date('2026-01-15T12:00'),
    });
    expect(isOverlapping(a, b)).toBe(false);
  });

  it('完全に離れたタイムブロックはfalse', () => {
    const a = createTimedTimeblock({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedTimeblock({
      id: 'b',
      start: new Date('2026-01-15T14:00'),
      end: new Date('2026-01-15T15:00'),
    });
    expect(isOverlapping(a, b)).toBe(false);
  });
});

// ========================================
// calculateMaxConcurrent
// ========================================

describe('calculateMaxConcurrent', () => {
  it('重複なしは1を返す', () => {
    const timeblocks = [
      createTimedTimeblock({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedTimeblock({
        id: 'b',
        start: new Date('2026-01-15T12:00'),
        end: new Date('2026-01-15T13:00'),
      }),
    ];
    expect(calculateMaxConcurrent(timeblocks)).toBe(1);
  });

  it('2つ重複は2を返す', () => {
    const timeblocks = [
      createTimedTimeblock({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedTimeblock({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
    ];
    expect(calculateMaxConcurrent(timeblocks)).toBe(2);
  });

  it('3つ同時重複は3を返す', () => {
    const timeblocks = [
      createTimedTimeblock({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T12:00'),
      }),
      createTimedTimeblock({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
      createTimedTimeblock({
        id: 'c',
        start: new Date('2026-01-15T11:00'),
        end: new Date('2026-01-15T12:00'),
      }),
    ];
    expect(calculateMaxConcurrent(timeblocks)).toBe(3);
  });
});

// ========================================
// detectOverlapGroups
// ========================================

describe('detectOverlapGroups', () => {
  it('空配列で空配列を返す', () => {
    expect(detectOverlapGroups([])).toEqual([]);
  });

  it('重複するタイムブロックを同一グループに', () => {
    const timeblocks = [
      createTimedTimeblock({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedTimeblock({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
    ];
    const groups = detectOverlapGroups(timeblocks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });
});

// ========================================
// calculateTimeblockPosition
// ========================================

describe('calculateTimeblockPosition', () => {
  it('10:00-11:00のタイムブロックを正しく配置（hourHeight=72）', () => {
    const timeblock = createTimedTimeblock({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const column = { timeblocks: [], columnIndex: 0, totalColumns: 1 };
    const pos = calculateTimeblockPosition(timeblock, column, 72);

    expect(pos.top).toBe(720); // 10 * 72
    expect(pos.height).toBe(72); // 1時間 * 72
    expect(pos.left).toBe(0);
    expect(pos.width).toBe(100);
  });

  it('最小高さ14pxを保証', () => {
    const timeblock = createTimedTimeblock({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T10:05:00'), // 5分 = 6px
    });
    const column = { timeblocks: [], columnIndex: 0, totalColumns: 1 };
    const pos = calculateTimeblockPosition(timeblock, column, 72);

    expect(pos.height).toBe(14);
  });

  it('2カラム中の2番目を正しく配置', () => {
    const timeblock = createTimedTimeblock({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const column = { timeblocks: [], columnIndex: 1, totalColumns: 2 };
    const pos = calculateTimeblockPosition(timeblock, column, 72);

    expect(pos.left).toBe(50);
    expect(pos.width).toBe(50);
  });
});
