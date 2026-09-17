/**
 * レイアウト計算エンジン — React/DOM依存ゼロの純粋関数
 *
 * Googleカレンダー風のsweep-lineアルゴリズムによる重複検出・カラム割り当てと、
 * タイムブロックカードの位置計算を提供。
 */

import type { TimeblockColumn, TimedTimeblock } from '../types/timeblock.types';

import { MIN_EVENT_HEIGHT } from './grid';

// ========================================
// 型定義
// ========================================

/** 重複レイアウト情報 */
export interface TimeblockLayout {
  timeblock: TimedTimeblock;
  /** 左から何番目のカラム（0始まり） */
  column: number;
  /** その時間帯の総カラム数 */
  totalColumns: number;
  /** 幅のパーセンテージ（例: 50, 33.33） */
  width: number;
  /** 左位置のパーセンテージ（例: 0, 50） */
  left: number;
}

/** 重複グループ */
interface OverlapGroup {
  timeblocks: TimedTimeblock[];
  startTime: Date;
  endTime: Date;
}

// ========================================
// Googleカレンダー風カラムレイアウト
// ========================================

/**
 * タイムブロックの重複レイアウトを一括計算（メインの入口）
 *
 * Googleカレンダー風の横並び配置:
 * 1. Plan を左側（column: 0）に配置
 * 2. Record を右側に配置
 */
export function calculateTimeblockLayouts(timeblocks: TimedTimeblock[]): TimeblockLayout[] {
  if (timeblocks.length === 0) return [];

  // Step 1: タイムブロックを開始時間でソート
  const sortedTimeblocks = [...timeblocks].sort((a, b) => {
    const aStart = new Date(a.start);
    const bStart = new Date(b.start);
    return aStart.getTime() - bStart.getTime();
  });

  // Step 2: 重複グループを検出
  const overlapGroups = findOverlapGroups(sortedTimeblocks);

  // Step 3: 各グループ内でレイアウトを計算
  const layouts: TimeblockLayout[] = [];

  overlapGroups.forEach((group) => {
    const groupLayouts = calculateGroupLayout(group.timeblocks);
    layouts.push(...groupLayouts);
  });

  return layouts;
}

/**
 * 重複するタイムブロックグループを検出（sweep-line）
 */
export function findOverlapGroups(timeblocks: TimedTimeblock[]): OverlapGroup[] {
  const groups: OverlapGroup[] = [];
  let currentGroup: TimedTimeblock[] = [];
  let groupEndTime: Date | null = null;

  timeblocks.forEach((timeblock) => {
    const timeblockStart = new Date(timeblock.start);
    const timeblockEnd = new Date(timeblock.end);

    if (!groupEndTime || timeblockStart >= groupEndTime) {
      if (currentGroup.length > 0) {
        groups.push({
          timeblocks: currentGroup,
          startTime: new Date(currentGroup[0]!.start),
          endTime: groupEndTime!,
        });
      }
      currentGroup = [timeblock];
      groupEndTime = timeblockEnd;
    } else {
      currentGroup.push(timeblock);
      if (timeblockEnd > groupEndTime) {
        groupEndTime = timeblockEnd;
      }
    }
  });

  if (currentGroup.length > 0 && groupEndTime) {
    groups.push({
      timeblocks: currentGroup,
      startTime: new Date(currentGroup[0]!.start),
      endTime: groupEndTime,
    });
  }

  return groups;
}

/**
 * グループ内のレイアウトを計算
 *
 * 列配置の優先順位:
 * 1. Plan（type !== 'record'）を左側（column: 0）に配置
 * 2. Record（type === 'record'）を右側に配置
 */
function calculateGroupLayout(timeblocks: TimedTimeblock[]): TimeblockLayout[] {
  const layouts: TimeblockLayout[] = [];

  // 各タイムブロックの「競合リスト」を作成
  const conflicts = new Map<string, Set<string>>();

  timeblocks.forEach((timeblock1) => {
    const conflictSet = new Set<string>();
    timeblocks.forEach((timeblock2) => {
      if (timeblock1.id !== timeblock2.id && isOverlapping(timeblock1, timeblock2)) {
        conflictSet.add(timeblock2.id);
      }
    });
    conflicts.set(timeblock1.id, conflictSet);
  });

  // 各タイムブロックにカラムを割り当て
  const assignments = new Map<string, number>();

  // Plan を左、Record を右に安定配置するため、kind を優先してから開始時刻順に割り当てる。
  const sortedForAssignment = [...timeblocks].sort((a, b) => {
    if (a.kind === 'plan' && b.kind === 'record') return -1;
    if (a.kind === 'record' && b.kind === 'plan') return 1;
    const timeDiff = new Date(a.start).getTime() - new Date(b.start).getTime();
    if (timeDiff !== 0) return timeDiff;
    return 0;
  });

  sortedForAssignment.forEach((timeblock) => {
    const usedColumns = new Set<number>();

    conflicts.get(timeblock.id)?.forEach((conflictId) => {
      if (assignments.has(conflictId)) {
        usedColumns.add(assignments.get(conflictId)!);
      }
    });

    let column = 0;
    while (usedColumns.has(column)) {
      column++;
    }

    assignments.set(timeblock.id, column);
  });

  const maxConcurrent = Math.max(
    1,
    ...Array.from(assignments.values()).map((column) => column + 1),
  );

  // レイアウト情報を生成
  timeblocks.forEach((timeblock) => {
    const column = assignments.get(timeblock.id)!;
    const width = 100 / maxConcurrent;
    const left = width * column;

    layouts.push({ timeblock, column, totalColumns: maxConcurrent, width, left });
  });

  return layouts;
}

/**
 * 2つのタイムブロックが時間的に重複しているかを判定
 *
 * 接触のみ（一方の end === 他方の start）は重複としない
 */
export function isOverlapping(timeblock1: TimedTimeblock, timeblock2: TimedTimeblock): boolean {
  return timeblock1.start < timeblock2.end && timeblock2.start < timeblock1.end;
}

/**
 * 最大同時重複数を計算（sweep-line）
 */
export function calculateMaxConcurrent(timeblocks: TimedTimeblock[]): number {
  const timePoints: { time: Date; type: 'start' | 'end'; timeblockId: string }[] = [];

  timeblocks.forEach((timeblock) => {
    const start = new Date(timeblock.start);
    const end = new Date(timeblock.end);
    timePoints.push({ time: start, type: 'start', timeblockId: timeblock.id });
    timePoints.push({ time: end, type: 'end', timeblockId: timeblock.id });
  });

  timePoints.sort((a, b) => {
    const timeDiff = a.time.getTime() - b.time.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.type === 'end' ? -1 : 1;
  });

  let current = 0;
  let max = 0;

  timePoints.forEach((point) => {
    if (point.type === 'start') {
      current++;
      max = Math.max(max, current);
    } else {
      current--;
    }
  });

  return max;
}

// ========================================
// タイムブロックカード配置
// ========================================

/**
 * タイムブロックグループを検出（重複するタイムブロックをグループ化）
 */
export function detectOverlapGroups(timeblocks: TimedTimeblock[]): TimedTimeblock[][] {
  if (timeblocks.length === 0) return [];

  const sortedTimeblocks = [...timeblocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  const groups: TimedTimeblock[][] = [];

  for (const timeblock of sortedTimeblocks) {
    let added = false;
    for (const group of groups) {
      if (group.some((p) => isOverlapping(p, timeblock))) {
        group.push(timeblock);
        added = true;
        break;
      }
    }
    if (!added) {
      groups.push([timeblock]);
    }
  }

  return groups;
}

/**
 * タイムブロックの表示位置を計算
 */
export function calculateTimeblockPosition(
  timeblock: TimedTimeblock,
  column: TimeblockColumn,
  hourHeight: number = 60,
): { top: number; height: number; left: number; width: number } {
  const startMinutes = timeblock.start.getHours() * 60 + timeblock.start.getMinutes();
  const endMinutes = timeblock.end.getHours() * 60 + timeblock.end.getMinutes();

  const top = (startMinutes * hourHeight) / 60;
  const height = Math.max(((endMinutes - startMinutes) * hourHeight) / 60, MIN_EVENT_HEIGHT);

  const width = 100 / column.totalColumns;
  const left = width * column.columnIndex;

  return { top, height, left, width };
}
