/**
 * `plans` の表示用射影型（Calendar Plan レーンでのレンダリングに使用）。
 *
 * `CalendarEvent`（entries 統合型）から独立した Step 5 の新規型。
 * `status` は「過去 Plan の見え方」（docs/product/specs/plan-record.md §記録操作と表示）を表現する:
 * - `upcoming` / `active`: 通常のアウトライン表示
 * - `unrecorded`: 過去・records なし（静かなプロンプト）
 * - `with-records`: 同じ時間帯の records あり。予定全体の完遂は意味しない
 */
export type PlanEventStatus = 'upcoming' | 'active' | 'unrecorded' | 'with-records';

export interface PlanEvent {
  id: string;
  title: string;
  note: string | null;
  activityId: string | null;
  startDate: Date;
  endDate: Date;
  /** タイムゾーン変換済みの表示用開始時刻 */
  displayStartDate: Date;
  /** タイムゾーン変換済みの表示用終了時刻 */
  displayEndDate: Date;
  /** 分単位の所要時間 */
  duration: number;
  status: PlanEventStatus;
  /** 未保存のプレビュー状態 */
  isDraft?: boolean | undefined;
}
