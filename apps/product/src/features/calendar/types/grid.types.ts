/** 時間列コンポーネントのプロパティ */
export interface TimeColumnProps {
  startHour?: number | undefined;
  endHour?: number | undefined;
  hourHeight?: number | undefined;
  format?: '12h' | '24h' | undefined; // 時刻表示形式
  className?: string | undefined;
  /** 列の幅（px）。未指定時は format / dense から resolveTimeColumnWidth で解く */
  width?: number | undefined;
  /** 狭い列（モバイル）向けにラベルを一段小さくする */
  dense?: boolean | undefined;
}

/** 現在時刻線コンポーネントのプロパティ */
export interface CurrentTimeLineProps {
  hourHeight?: number | undefined;
  timeColumnWidth?: number | undefined;
  containerWidth?: number | undefined;
  className?: string | undefined;
  showDot?: boolean | undefined; // 現在時刻のドットを表示するか
  updateInterval?: number | undefined; // 更新間隔（ミリ秒）
  // 複数日ビュー用の新しいProps
  displayDates?: Date[] | undefined; // 表示している日付の配列
  viewMode?: 'day' | '3day' | '5day' | 'week' | undefined;
  /** 他の日にも薄い線を表示するか（デフォルト: true） */
  showOnOtherDays?: boolean | undefined;
  /** 表示範囲（開始時間, 0-24）。範囲外なら非表示 */
  startHour?: number | undefined;
  /** 表示範囲（終了時間, 0-24）。範囲外なら非表示 */
  endHour?: number | undefined;
}

/** 15分単位の時間スロット */
export interface TimeSlot {
  time: string; // "09:15"
  hour: number; // 9
  minute: number; // 15
  label: string; // "9:00" または "09:15"
  isHour: boolean; // true if 正時(00分)
  isHalfHour: boolean; // true if 30分
  isQuarterHour: boolean; // true if 15分または45分
}
