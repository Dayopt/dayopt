import type { TimeblockDestination } from '../domain/timeblock-destination';

/**
 * Timeblock の表示用射影型（カレンダー上でのレンダリングに使用）。
 *
 * `kind` で plans / records のどちらの射影かが決まる。時刻は `startDate` / `endDate` の
 * 1 組だけを持ち、Plan の予定時刻と Record の実績時刻を別フィールドへ分けない
 * （旧 entries 統合モデルの `planned_*` / `actual_*` は 2026-09-16 に撤去）。
 */
export interface CalendarEvent {
  id: string;
  title: string;
  description?: string | undefined;
  startDate: Date | null;
  endDate: Date | null;
  color: string;
  activityId?: string | null | undefined;
  /** DB compare-and-swap用の生のupdated_at。Dateへ変換せずmutationへ渡す。 */
  version: string;
  // Display-specific properties
  displayStartDate: Date;
  displayEndDate: Date;
  duration: number; // minutes
  isMultiDay: boolean;
  /** 射影元が plans / records のどちらか。クリック・DnD・削除のルーティングに使う */
  kind: TimeblockDestination;
  /** record の作成元（manual / from_plan / auto_migrated / external_calendar）。auto_migrated は RLS で不変 */
  recordSource?: string | undefined;
  // ドラフト状態（未保存のプレビュー）
  isDraft?: boolean | undefined;
}
