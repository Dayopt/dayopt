/**
 * 重複判定エンジン — React/DOM依存ゼロの純粋関数
 *
 * ドラッグ操作時のクライアント側重複チェックを提供。
 * 同一レーンの Timeblock 間で重複を禁止する。
 */

import { rangesOverlap, type TwoLayerOverlapTarget } from '@/lib/time';
import type { CalendarDisplayEvent } from '../types/calendar.types';

export function buildNewTimeblockOverlapTarget(
  startTime: Date,
  endTime: Date,
  now: number = Date.now(),
): TwoLayerOverlapTarget {
  const isPast = endTime.getTime() <= now;

  // 自動記録モデル: 未来の Plan は actual NULL で作成されるため planned レイヤーだけを
  // 占有する。過去スロットで作る Record は actual レイヤーのみ。
  return {
    id: '',
    plannedStart: isPast ? null : startTime,
    plannedEnd: isPast ? null : endTime,
    actualStart: isPast ? startTime : null,
    actualEnd: isPast ? endTime : null,
  };
}

/**
 * ドラッグ/リサイズ中の kind-aware 重複判定（plan×plan / record×record のみ禁止、plan×record は許可）。
 * ドラッグ移動先が同一 kind の他イベントと重ならないかだけを見る。
 */
export function checkClientSideOverlapByKind(
  events: CalendarDisplayEvent[],
  draggedEventId: string,
  previewStartTime: Date,
  previewEndTime: Date,
  options: {
    /** レーン間ドラッグ時に、ドラッグ元ではなくdrop先のkindで判定する。 */
    targetKind?: NonNullable<CalendarDisplayEvent['kind']>;
    now?: number;
  } = {},
): boolean {
  const now = options.now ?? Date.now();
  const draggedEvent = events.find((event) => event.id === draggedEventId);
  const kind =
    options.targetKind ??
    draggedEvent?.kind ??
    (previewEndTime.getTime() > now ? 'plan' : 'record');
  return events.some((event) => {
    if (event.id === draggedEventId) return false;
    if ((event.kind ?? 'plan') !== kind) return false;
    const otherStart = event.startDate ?? event.displayStartDate;
    const otherEnd = event.endDate ?? event.displayEndDate;
    if (otherStart == null || otherEnd == null) return false;
    return rangesOverlap(previewStartTime, previewEndTime, otherStart, otherEnd);
  });
}
