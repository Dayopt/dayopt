/**
 * Plan レーン + Record レーンの 2 レーン座標計算（Step 5、read 側専用。
 * #2250 で常時固定幅分割から区間ごとの動的幅判定へ変更）。
 *
 * `plans_no_overlap` / `records_no_overlap`（DB EXCLUDE 制約、半開区間）により、
 * 同一ユーザーの plans 同士・records 同士は決して時間的に重ならない。そのため
 * 既存 `layout.ts` の `calculateGroupLayout`（時間重複を動的に検出して
 * column を割り当てる sweep-line）は不要で、各レーン内は「その日の時刻から
 * 座標を出すだけ」で足りる。
 *
 * レーン幅は entry 単位で決める（時間軸の途中で 1 entry の幅が変わることはない）:
 * 相手レーンに時間の重なる entry が 1 件でもあれば従来どおり Plan=左・Record=右の
 * 固定幅分割、無ければその entry はフル幅（0-100%）で描画する。`DEFAULT_PLAN_LANE_WIDTH_PERCENT`
 * は「split 時の Plan レーン幅」であり、「常時のレーン幅」ではない点に注意する。
 *
 * この動的幅判定は表示だけでなく、ドラッグ中の pointer→lane 判定
 * （`resolveTwoLaneFromPointer`）・ドラッグゴースト（`CalendarGridContent.renderGhost`）・
 * 選択後ハイライト（`DragSelectionHighlight`）・選択中プレビュー（`DragSelectionPreview`）の
 * 4 経路でも同じ `hasLaneCounterpart` を用いて揃える。表示上フル幅（境界不可視）なのに
 * pointer 判定だけ旧固定境界のままだと、境界の見えないカラムで意図せず
 * Plan→Record 変換 mutation が発火する（#2250 plan-review で検出、P1 級）。
 *
 * 呼び出し側は対象日の plans/records だけを渡す想定（日をまたぐ絞り込みは
 * 呼び出し側の責務、TwoLaneDayColumn と同じ分担）。この日次スコープの前提により、
 * 日をまたぐ entry の重複判定も `displayStartDate`/`displayEndDate`（実時刻）を
 * そのまま比較すれば足りる（px 座標は `timeToPosition` が 24:00 でクランプするが、
 * 相手レーンの候補リスト自体が既に当日分だけに絞られているため、実時刻ベースの
 * 判定と px 座標のクランプは競合しない）。
 */

import type { PlanEvent, RecordEvent } from '@/features/timeblock';

import type { CalendarDisplayEvent } from '../types/calendar.types';

export interface TwoLanePosition {
  /** px */
  top: number;
  /** px */
  height: number;
  /** % */
  left: number;
  /** % */
  width: number;
}

interface TwoLaneLayoutItem<T> {
  entry: T;
  position: TwoLanePosition;
}

interface TwoLaneLayoutResult {
  planLayouts: TwoLaneLayoutItem<PlanEvent>[];
  recordLayouts: TwoLaneLayoutItem<RecordEvent>[];
}

interface CalculateTwoLaneLayoutOptions {
  plans: ReadonlyArray<PlanEvent>;
  records: ReadonlyArray<RecordEvent>;
  /** 1 時間あたりの px */
  hourHeight: number;
  /** Plan レーンの幅（%）。既定 38（Record レーンが主役で広め、overview.md §4） */
  planLaneWidthPercent?: number;
}

const DAY_MINUTES = 24 * 60;
/** day / week / multi-day で共有する、重複時（split 時）の Plan レーン幅の契約。 */
export const DEFAULT_PLAN_LANE_WIDTH_PERCENT = 38;
const TWO_LANE_MIN_GAP_PX: number = 2;

/**
 * 相手レーンに時間の重なる entry が存在するか判定する。
 *
 * 重複判定は実時刻（`displayStartDate`/`displayEndDate`）の半開区間比較で行う
 * （`[targetStart, targetEnd)` と `[counterpart.start, counterpart.end)` が交差するか）。
 * `targetEnd <= targetStart`（0 秒以下・巻き戻り）の縮退区間は「重複なし」と
 * 誤判定してフル幅にすると 0 幅カードが全幅で他 entry と重なる事故になるため、
 * 安全側（相手が存在する扱い = split 幅）に倒す。
 */
export function hasLaneCounterpart(
  counterparts: ReadonlyArray<{ displayStartDate: Date; displayEndDate: Date }>,
  targetStart: Date,
  targetEnd: Date,
): boolean {
  const targetStartMs = targetStart.getTime();
  const targetEndMs = targetEnd.getTime();
  if (targetEndMs <= targetStartMs) return true;
  return counterparts.some((counterpart) => {
    const counterpartStartMs = counterpart.displayStartDate.getTime();
    const counterpartEndMs = counterpart.displayEndDate.getTime();
    if (counterpartEndMs <= counterpartStartMs) return false;
    return targetStartMs < counterpartEndMs && counterpartStartMs < targetEndMs;
  });
}

/**
 * カラム内の pointer X から Plan / Record の drop 先レーンを決める。
 *
 * `laneAvailability` を渡すと、その時刻に相手レーンの entry が存在しない
 * （= 画面上フル幅で境界が見えていない）場合は pointer の x 座標に関わらず
 * `sourceLane` をそのまま返す。境界の無いカラムで意図しない
 * Plan→Record 変換が起きるのを防ぐための安全弁（#2250）。省略時は従来どおり
 * 常に x 座標だけで判定する（既存 test / 呼び出し元との互換を保つ）。
 */
export function resolveTwoLaneFromPointer(
  clientX: number,
  columnLeft: number,
  columnWidth: number,
  planLaneWidthPercent: number = DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  laneAvailability?: { sourceLane: 'plan' | 'record'; hasCounterpart: boolean },
): 'plan' | 'record' {
  if (laneAvailability && !laneAvailability.hasCounterpart) {
    return laneAvailability.sourceLane;
  }
  const boundary = columnLeft + columnWidth * (planLaneWidthPercent / 100);
  return clientX < boundary ? 'plan' : 'record';
}

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function buildLaneLayout<T extends { displayStartDate: Date; displayEndDate: Date; id: string }>(
  items: ReadonlyArray<T>,
  counterparts: ReadonlyArray<{ displayStartDate: Date; displayEndDate: Date }>,
  splitLeft: number,
  splitWidth: number,
  hourHeight: number,
): Array<TwoLaneLayoutItem<T>> {
  const sorted = items
    .map((entry) => {
      const { top, height } = timeToPosition(
        entry.displayStartDate,
        entry.displayEndDate,
        hourHeight,
      );
      // 重複判定は実時刻ベース（px クランプ前）で行う。gap 調整は同一レーン内の
      // 視覚的な詰め込み対策であり、相手レーンとの時間重複とは無関係なため、
      // gap 適用前の displayStartDate/displayEndDate を判定に使う。
      const hasCounterpart = hasLaneCounterpart(
        counterparts,
        entry.displayStartDate,
        entry.displayEndDate,
      );
      return { entry, top, height, hasCounterpart };
    })
    .sort((a, b) => a.top - b.top || a.entry.id.localeCompare(b.entry.id));

  const layouts: Array<TwoLaneLayoutItem<T>> = [];
  let previousOriginalBottomPx: number | null = null;

  for (const item of sorted) {
    const gapOffset =
      previousOriginalBottomPx === null
        ? 0
        : Math.max(previousOriginalBottomPx + TWO_LANE_MIN_GAP_PX - item.top, 0);
    const top = item.top + gapOffset;
    const height = Math.max(item.height - gapOffset, 0);
    const position: TwoLanePosition = {
      top,
      height,
      left: item.hasCounterpart ? splitLeft : 0,
      width: item.hasCounterpart ? splitWidth : 100,
    };

    layouts.push({ entry: item.entry, position });
    previousOriginalBottomPx = item.top + item.height;
  }

  return layouts;
}

/**
 * 日カラム内での top/height（px）を計算する。
 *
 * 日をまたぐ（`end` が `start` と別日、または `end <= start`）場合は
 * 当日の終端（24:00）でクランプする。複数日にまたがる描画は呼び出し側の
 * 責務（このカラムは 1 日分の座標だけを担当する）。
 */
function timeToPosition(
  start: Date,
  end: Date,
  hourHeight: number,
): { top: number; height: number } {
  const startMinutes = minutesSinceMidnight(start);
  const crossesMidnight = end.getTime() <= start.getTime() || end.getDate() !== start.getDate();
  const endMinutes = crossesMidnight ? DAY_MINUTES : minutesSinceMidnight(end);

  const top = (startMinutes / 60) * hourHeight;
  const height = Math.max(((endMinutes - startMinutes) / 60) * hourHeight, 0);
  return { top, height };
}

export function calculateTwoLaneLayout({
  plans,
  records,
  hourHeight,
  planLaneWidthPercent = DEFAULT_PLAN_LANE_WIDTH_PERCENT,
}: CalculateTwoLaneLayoutOptions): TwoLaneLayoutResult {
  const recordLaneWidthPercent = 100 - planLaneWidthPercent;
  const planLayouts = buildLaneLayout(plans, records, 0, planLaneWidthPercent, hourHeight);
  const recordLayouts = buildLaneLayout(
    records,
    plans,
    planLaneWidthPercent,
    recordLaneWidthPercent,
    hourHeight,
  );

  return { planLayouts, recordLayouts };
}

/**
 * `CalendarDisplayEvent[]`（Step 8 の time model 射影、`kind` 付き）から直接 2 レーン座標を計算する。
 * `TwoLaneTimeblockRenderer` はインタラクション状態（drag/resize preview）を CalendarDisplayEvent 単位で
 * 持つ既存 `useInteraction` をそのまま使うため、PlanEvent/RecordEvent への変換を経由しない。
 */
export function calculateTwoLaneStylesForCalendarEvents(
  events: ReadonlyArray<CalendarDisplayEvent>,
  hourHeight: number,
  planLaneWidthPercent: number = DEFAULT_PLAN_LANE_WIDTH_PERCENT,
): Record<string, TwoLanePosition> {
  const recordLaneWidthPercent = 100 - planLaneWidthPercent;
  const styles: Record<string, TwoLanePosition> = {};
  const records = [];
  const plans = [];

  for (const event of events) {
    const start = event.displayStartDate ?? event.startDate;
    const end = event.displayEndDate ?? event.endDate;
    if (!start || !end) continue;
    if (event.kind === 'record') {
      records.push({
        ...event,
        displayStartDate: start,
        displayEndDate: end,
      });
    } else {
      plans.push({
        ...event,
        displayStartDate: start,
        displayEndDate: end,
      });
    }
  }

  for (const { entry, position } of buildLaneLayout(
    plans,
    records,
    0,
    planLaneWidthPercent,
    hourHeight,
  )) {
    styles[entry.id] = position;
  }

  for (const { entry, position } of buildLaneLayout(
    records,
    plans,
    planLaneWidthPercent,
    recordLaneWidthPercent,
    hourHeight,
  )) {
    styles[entry.id] = position;
  }

  return styles;
}
