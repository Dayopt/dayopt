import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';

import type { TimedTimeblock } from '../types/timeblock.types';

import {
  calculateMaxConcurrent,
  calculateTimeblockLayouts,
  calculateTimeblockPosition,
  computeActualTimeDiffOverlay,
  detectOverlapGroups,
  findOverlapGroups,
  isOverlapping,
} from './layout';

// ========================================
// テストヘルパー
// ========================================

function createTimedEntry(
  overrides: Partial<TimedTimeblock> & { start: Date; end: Date },
): TimedTimeblock {
  return {
    id: 'test-1',
    title: 'Test Entry',
    startDate: overrides.start,
    endDate: overrides.end,
    displayStartDate: overrides.start,
    displayEndDate: overrides.end,
    duration: (overrides.end.getTime() - overrides.start.getTime()) / 60000,
    isMultiDay: false,

    status: 'open',
    color: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    kind: 'plan',
    ...overrides,
  } as TimedTimeblock;
}

function createCalendarEvent(
  overrides: Partial<CalendarDisplayEvent> & { startDate: Date; endDate: Date },
): CalendarDisplayEvent {
  return {
    id: 'test-1',
    title: 'Test Event',
    displayStartDate: overrides.startDate,
    displayEndDate: overrides.endDate,
    duration: (overrides.endDate.getTime() - overrides.startDate.getTime()) / 60000,
    isMultiDay: false,

    status: 'open',
    color: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    kind: 'plan',
    ...overrides,
  } as CalendarDisplayEvent;
}

// ========================================
// calculateTimeblockLayouts
// ========================================

describe('calculateTimeblockLayouts', () => {
  it('空配列で空のレイアウトを返す', () => {
    expect(calculateTimeblockLayouts([])).toEqual([]);
  });

  it('単一エントリはfull widthで配置', () => {
    const entry = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const layouts = calculateTimeblockLayouts([entry]);

    expect(layouts).toHaveLength(1);
    expect(layouts[0]!.column).toBe(0);
    expect(layouts[0]!.totalColumns).toBe(1);
    expect(layouts[0]!.width).toBe(100);
    expect(layouts[0]!.left).toBe(0);
  });

  it('重複する2エントリは50%ずつに分割', () => {
    const entry1 = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const entry2 = createTimedEntry({
      id: 'b',
      start: new Date('2026-01-15T10:30:00'),
      end: new Date('2026-01-15T11:30:00'),
    });
    const layouts = calculateTimeblockLayouts([entry1, entry2]);

    expect(layouts).toHaveLength(2);
    expect(layouts[0]!.totalColumns).toBe(2);
    expect(layouts[1]!.totalColumns).toBe(2);
    expect(layouts[0]!.width).toBe(50);
    expect(layouts[1]!.width).toBe(50);
  });

  it('planned の未実行前半 gap に作った unplanned は右側に横割りする', () => {
    const unplannedGapRecord = createTimedEntry({
      id: 'gap-record',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T10:30:00'),
      actualStartDate: new Date('2026-01-15T10:00:00'),
      actualEndDate: new Date('2026-01-15T10:30:00'),
      kind: 'record',
    });
    const planned = createTimedEntry({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      plannedStartDate: new Date('2026-01-15T10:00:00'),
      plannedEndDate: new Date('2026-01-15T11:00:00'),
      actualStartDate: new Date('2026-01-15T10:30:00'),
      actualEndDate: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });

    const layouts = calculateTimeblockLayouts([unplannedGapRecord, planned]);
    const plannedLayout = layouts.find((layout) => layout.entry.id === 'planned');
    const recordLayout = layouts.find((layout) => layout.entry.id === 'gap-record');

    expect(plannedLayout).toMatchObject({ column: 0, left: 0, width: 50, totalColumns: 2 });
    expect(recordLayout).toMatchObject({ column: 1, left: 50, width: 50, totalColumns: 2 });
  });

  it('planned の actual 範囲に重なる unplanned は従来通り横割りする', () => {
    const planned = createTimedEntry({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      plannedStartDate: new Date('2026-01-15T10:00:00'),
      plannedEndDate: new Date('2026-01-15T11:00:00'),
      actualStartDate: new Date('2026-01-15T10:30:00'),
      actualEndDate: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    const overlappingRecord = createTimedEntry({
      id: 'overlap-record',
      start: new Date('2026-01-15T10:15:00'),
      end: new Date('2026-01-15T10:45:00'),
      actualStartDate: new Date('2026-01-15T10:15:00'),
      actualEndDate: new Date('2026-01-15T10:45:00'),
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
    const unplanned = createTimedEntry({
      id: 'unplanned',
      start: new Date('2026-01-15T09:45:00'),
      end: new Date('2026-01-15T10:15:00'),
      actualStartDate: new Date('2026-01-15T09:45:00'),
      actualEndDate: new Date('2026-01-15T10:15:00'),
      kind: 'record',
    });
    const planned = createTimedEntry({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });

    const layouts = calculateTimeblockLayouts([unplanned, planned]);
    const plannedLayout = layouts.find((layout) => layout.entry.id === 'planned');
    const unplannedLayout = layouts.find((layout) => layout.entry.id === 'unplanned');

    expect(plannedLayout).toMatchObject({ column: 0, left: 0, width: 50, totalColumns: 2 });
    expect(unplannedLayout).toMatchObject({ column: 1, left: 50, width: 50, totalColumns: 2 });
  });

  it('重複しない2エントリは各自full width', () => {
    const entry1 = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const entry2 = createTimedEntry({
      id: 'b',
      start: new Date('2026-01-15T12:00:00'),
      end: new Date('2026-01-15T13:00:00'),
    });
    const layouts = calculateTimeblockLayouts([entry1, entry2]);

    expect(layouts).toHaveLength(2);
    layouts.forEach((layout) => {
      expect(layout.totalColumns).toBe(1);
      expect(layout.width).toBe(100);
    });
  });

  it('同一時刻のエントリはID順で配置', () => {
    const planned = createTimedEntry({
      id: 'planned',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    const laterEntry = createTimedEntry({
      id: 'later-entry',
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
      kind: 'plan',
    });
    // 後発エントリを先に渡しても、早い方がcolumn 0になるべき
    const layouts = calculateTimeblockLayouts([laterEntry, planned]);

    const plannedLayout = layouts.find((l) => l.entry.id === 'planned');
    const laterLayout = layouts.find((l) => l.entry.id === 'later-entry');

    expect(plannedLayout!.column).toBe(1);
    expect(laterLayout!.column).toBe(0);
  });
});

// ========================================
// findOverlapGroups
// ========================================

describe('findOverlapGroups', () => {
  it('重複するエントリをグループ化', () => {
    const entries = [
      createTimedEntry({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedEntry({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
      createTimedEntry({
        id: 'c',
        start: new Date('2026-01-15T14:00'),
        end: new Date('2026-01-15T15:00'),
      }),
    ];
    const groups = findOverlapGroups(entries);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries).toHaveLength(2);
    expect(groups[1]!.entries).toHaveLength(1);
  });
});

// ========================================
// isOverlapping
// ========================================

describe('isOverlapping', () => {
  it('時間が重なるエントリはtrue', () => {
    const a = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedEntry({
      id: 'b',
      start: new Date('2026-01-15T10:30'),
      end: new Date('2026-01-15T11:30'),
    });
    expect(isOverlapping(a, b)).toBe(true);
  });

  it('接触のみ（endとstartが同時刻）はfalse', () => {
    const a = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedEntry({
      id: 'b',
      start: new Date('2026-01-15T11:00'),
      end: new Date('2026-01-15T12:00'),
    });
    expect(isOverlapping(a, b)).toBe(false);
  });

  it('完全に離れたエントリはfalse', () => {
    const a = createTimedEntry({
      id: 'a',
      start: new Date('2026-01-15T10:00'),
      end: new Date('2026-01-15T11:00'),
    });
    const b = createTimedEntry({
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
    const entries = [
      createTimedEntry({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedEntry({
        id: 'b',
        start: new Date('2026-01-15T12:00'),
        end: new Date('2026-01-15T13:00'),
      }),
    ];
    expect(calculateMaxConcurrent(entries)).toBe(1);
  });

  it('2つ重複は2を返す', () => {
    const entries = [
      createTimedEntry({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedEntry({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
    ];
    expect(calculateMaxConcurrent(entries)).toBe(2);
  });

  it('3つ同時重複は3を返す', () => {
    const entries = [
      createTimedEntry({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T12:00'),
      }),
      createTimedEntry({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
      createTimedEntry({
        id: 'c',
        start: new Date('2026-01-15T11:00'),
        end: new Date('2026-01-15T12:00'),
      }),
    ];
    expect(calculateMaxConcurrent(entries)).toBe(3);
  });
});

// ========================================
// detectOverlapGroups
// ========================================

describe('detectOverlapGroups', () => {
  it('空配列で空配列を返す', () => {
    expect(detectOverlapGroups([])).toEqual([]);
  });

  it('重複するエントリを同一グループに', () => {
    const entries = [
      createTimedEntry({
        id: 'a',
        start: new Date('2026-01-15T10:00'),
        end: new Date('2026-01-15T11:00'),
      }),
      createTimedEntry({
        id: 'b',
        start: new Date('2026-01-15T10:30'),
        end: new Date('2026-01-15T11:30'),
      }),
    ];
    const groups = detectOverlapGroups(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });
});

// ========================================
// calculateTimeblockPosition
// ========================================

describe('calculateTimeblockPosition', () => {
  it('10:00-11:00のエントリを正しく配置（hourHeight=72）', () => {
    const entry = createTimedEntry({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const column = { entries: [], columnIndex: 0, totalColumns: 1 };
    const pos = calculateTimeblockPosition(entry, column, 72);

    expect(pos.top).toBe(720); // 10 * 72
    expect(pos.height).toBe(72); // 1時間 * 72
    expect(pos.left).toBe(0);
    expect(pos.width).toBe(100);
  });

  it('最小高さ14pxを保証', () => {
    const entry = createTimedEntry({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T10:05:00'), // 5分 = 6px
    });
    const column = { entries: [], columnIndex: 0, totalColumns: 1 };
    const pos = calculateTimeblockPosition(entry, column, 72);

    expect(pos.height).toBe(14);
  });

  it('2カラム中の2番目を正しく配置', () => {
    const entry = createTimedEntry({
      start: new Date('2026-01-15T10:00:00'),
      end: new Date('2026-01-15T11:00:00'),
    });
    const column = { entries: [], columnIndex: 1, totalColumns: 2 };
    const pos = calculateTimeblockPosition(entry, column, 72);

    expect(pos.left).toBe(50);
    expect(pos.width).toBe(50);
  });
});

// ========================================
// computeActualTimeDiffOverlay
// ========================================

describe('computeActualTimeDiffOverlay', () => {
  it('past + planned + 実績ありのイベントでオーバーレイを計算', () => {
    const event = createCalendarEvent({
      id: 'test',
      startDate: new Date('2026-01-15T10:00:00'),
      endDate: new Date('2026-01-15T11:00:00'),
      actualStartDate: new Date('2026-01-15T10:15:00'), // 15分遅れ
      actualEndDate: new Date('2026-01-15T11:00:00'),
      timeblockState: 'past',
      kind: 'plan',
    });
    const overlay = computeActualTimeDiffOverlay(event, 72);

    expect(overlay.topKind).toBe('unexecuted'); // 遅れ開始 = 未実行
    expect(overlay.topHeight).toBe(18); // 15分 * 72 / 60 = 18px
    expect(overlay.bottomKind).toBe('none');
  });

  it('upcoming/activeイベントはオーバーレイなし', () => {
    const event = createCalendarEvent({
      startDate: new Date('2099-01-15T10:00:00'),
      endDate: new Date('2099-01-15T11:00:00'),
      timeblockState: 'upcoming',
      kind: 'plan',
    });
    const overlay = computeActualTimeDiffOverlay(event, 72);

    expect(overlay.topKind).toBe('none');
    expect(overlay.bottomKind).toBe('none');
    expect(overlay.topShift).toBe(0);
    expect(overlay.heightDelta).toBe(0);
  });

  it('実績時刻なしのイベントはオーバーレイなし', () => {
    const event = createCalendarEvent({
      startDate: new Date('2026-01-15T10:00:00'),
      endDate: new Date('2026-01-15T11:00:00'),
      timeblockState: 'past',
      kind: 'plan',
    });
    const overlay = computeActualTimeDiffOverlay(event, 72);
    expect(overlay.topKind).toBe('none');
  });

  it('早期開始は overtime', () => {
    const event = createCalendarEvent({
      startDate: new Date('2026-01-15T10:00:00'),
      endDate: new Date('2026-01-15T11:00:00'),
      actualStartDate: new Date('2026-01-15T09:45:00'), // 15分早い
      actualEndDate: new Date('2026-01-15T11:00:00'),
      timeblockState: 'past',
      kind: 'plan',
    });
    const overlay = computeActualTimeDiffOverlay(event, 72);

    expect(overlay.topKind).toBe('overtime');
    expect(overlay.topHeight).toBe(18); // 15分 * 72 / 60
    expect(overlay.topShift).toBe(18);
  });
});
