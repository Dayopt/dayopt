import type { TimeblockState } from '@/lib/time';
import type { TimeblockDestination } from '../domain/timeblock-destination';

/** Timeblock の表示用射影型（カレンダー上でのレンダリングに使用） */
export interface CalendarEvent {
  id: string;
  title: string;
  description?: string | undefined;
  startDate: Date | null;
  endDate: Date | null;
  status: 'open' | 'closed';
  color: string;
  activityId?: string | null | undefined;
  createdAt: Date;
  updatedAt: Date;
  /** DB compare-and-swap用の生のupdated_at。Dateへ変換せずmutationへ渡す。 */
  version: string;
  // Display-specific properties
  displayStartDate: Date;
  displayEndDate: Date;
  duration: number; // minutes
  isMultiDay: boolean;
  // === Timeblock 統合フィールド ===
  /** 時間位置ベースの状態（upcoming/active/past） */
  timeblockState?: TimeblockState | undefined;
  /** 実記録の開始時刻（actual_start_time から変換） */
  actualStartDate?: Date | null | undefined;
  /** 実記録の終了時刻（actual_end_time から変換） */
  actualEndDate?: Date | null | undefined;
  /** 予定の開始時刻。Record（kind: 'record'）では null */
  plannedStartDate?: Date | null | undefined;
  /** 予定の終了時刻。Record（kind: 'record'）では null */
  plannedEndDate?: Date | null | undefined;
  // === time model 射影フィールド（Step 8 cutover） ===
  /** 射影元が plans / records のどちらか。クリック・DnD・削除のルーティングに使う */
  kind?: TimeblockDestination | undefined;
  /** record の作成元（manual / from_plan / auto_migrated / external_calendar）。auto_migrated は RLS で不変 */
  recordSource?: string | undefined;
  /**
   * 紐づく Plan に対する Record 群の合計実績差分（実績 - 予定、分）。
   * 1 Plan : N Record では代表 Record 1件だけが値を持ち、他の Record は undefined。
   */
  // Optional properties used in various contexts
  userId?: string | undefined; // 所有者ID
  location?: string | undefined; // 場所
  url?: string | undefined; // 関連URL
  priority?: 'urgent' | 'important' | 'necessary' | 'delegate' | 'optional' | undefined; // 優先度
  // ドラフト状態（未保存のプレビュー）
  isDraft?: boolean | undefined;
}
