import { rangesOverlap } from '@/lib/time';
import type { QueryClient } from '@tanstack/react-query';

interface TimeblockLaneItem {
  id: string;
  start_at: string;
  end_at: string;
}

/** 指定レーンの list cache query を判定する predicate（tRPC v11 key 形式）。 */
function isLaneListQuery(lane: 'plans' | 'records') {
  return (query: { queryKey: unknown }): boolean => {
    const key = query.queryKey;
    return (
      Array.isArray(key) && Array.isArray(key[0]) && key[0][0] === lane && key[0][1] === 'list'
    );
  };
}

/** cache 済みの plans.list / records.list から重複判定用の行を id 重複なしで集める。 */
export function collectTimeblockLaneItems(
  queryClient: QueryClient,
  lane: 'plans' | 'records',
): TimeblockLaneItem[] {
  const lists = queryClient.getQueriesData<TimeblockLaneItem[]>({
    predicate: isLaneListQuery(lane),
  });
  const seen = new Set<string>();
  const items: TimeblockLaneItem[] = [];
  for (const [, data] of lists) {
    if (!data) continue;
    for (const row of data) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
    }
  }
  return items;
}

/**
 * 同一レーンの時間重複を判定する。
 * 半開区間で判定し、編集中の行は excludeId で除外する。
 */
export function hasTimeblockLaneConflict(
  items: TimeblockLaneItem[],
  startAt: Date,
  endAt: Date,
  excludeId?: string,
): boolean {
  return items.some(
    (item) => item.id !== excludeId && rangesOverlap(startAt, endAt, item.start_at, item.end_at),
  );
}

/**
 * `startAt` 以降で、同一レーンの既存ブロックと重ならない最初の枠を探す。
 *
 * 重なったブロックの終わりから試し直すので、連続して埋まっていても順に先へ進む。
 * `searchLimitAt` までに長さが丸ごと入る枠が無ければ `null`（呼び出し側が知らせる）。
 * 長さは縮めない。中央値どおりの長さで作れる場所だけを返す。
 */
export function findFreeTimeblockLaneSlot(
  items: TimeblockLaneItem[],
  startAt: Date,
  durationMinutes: number,
  searchLimitAt: Date,
): { startAt: Date; endAt: Date } | null {
  const durationMs = durationMinutes * 60_000;
  const limit = searchLimitAt.getTime();
  const blocking = items
    .map((item) => ({ start: Date.parse(item.start_at), end: Date.parse(item.end_at) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
    .sort((a, b) => a.start - b.start);

  let start = startAt.getTime();
  // 各周回で必ず「重なったブロックの終わり」へ進むので、ブロック数だけ回れば必ず終わる
  for (let guard = 0; guard <= blocking.length; guard += 1) {
    const end = start + durationMs;
    if (end > limit) return null;
    const hit = blocking.find((item) => item.start < end && item.end > start);
    if (!hit) return { startAt: new Date(start), endAt: new Date(end) };
    start = hit.end;
  }
  return null;
}
