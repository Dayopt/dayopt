/** Independent record display projection. */
export interface RecordEvent {
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
  /** 未保存のプレビュー状態 */
  isDraft?: boolean | undefined;
}
