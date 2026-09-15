/**
 * CalendarDragSelection 型定義
 */

import type { TimeFormat } from '@/lib/time';

import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

/** ドラッグ選択の時間範囲（時・分単位） */
export interface TimeRange {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** 日付を含む時間範囲選択結果 */
export interface DateTimeSelection extends TimeRange {
  date: Date;
  /** 選択の発生元。planned gap 由来の作成だけ preview を記録レーンに寄せる。 */
  creationSource?: 'planned-gap' | undefined;
  /**
   * 長さの出どころ。`dragged` は範囲を引いて長さまで決めた選択（アクティビティの
   * 普段の長さで上書きしない）。未指定はクリック / タップ起点の既定の長さ
   */
  durationSource?: 'dragged' | undefined;
}

/** CalendarDragSelection コンポーネントのプロパティ */
export interface CalendarDragSelectionProps {
  /** 必須：この列が担当する日付 */
  date: Date;
  /** この列の日付インデックス（DnDProvider → store 連携用） */
  dayIndex?: number | undefined;
  className?: string | undefined;
  onTimeRangeSelect?: ((selection: DateTimeSelection) => void) | undefined;
  /** ダブルクリック専用ハンドラー（オプション、未指定時はonTimeRangeSelectが呼ばれる） */
  onDoubleClick?: ((selection: DateTimeSelection) => void) | undefined;
  children?: React.ReactNode | undefined;
  /** ドラッグ選択を無効にする */
  disabled?: boolean | undefined;
  /** 重複チェック用のプラン一覧 */
  plans?: CalendarDisplayEvent[] | undefined;
  /** 新規作成時の既定時間（分） */
  defaultDuration: number;
  /** ユーザー設定に基づく時刻表記 */
  timeFormat: TimeFormat;
}

/** useDragSelection フックへの入力プロパティ */
export interface UseDragSelectionOptions {
  date: Date;
  dayIndex?: number | undefined;
  disabled?: boolean | undefined;
  onTimeRangeSelect?: ((selection: DateTimeSelection) => void) | undefined;
  onDoubleClick?: ((selection: DateTimeSelection) => void) | undefined;
  plans?: CalendarDisplayEvent[] | undefined;
  hourHeight?: number | undefined;
  defaultDuration: number;
  timeFormat: TimeFormat;
}

/** useDragSelection フックの戻り値 */
export interface UseDragSelectionReturn {
  isSelecting: boolean;
  selection: TimeRange | null;
  showSelectionPreview: boolean;
  isOverlapping: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
  handleTouchStart: (e: React.TouchEvent) => void;
  formatTime: (hour: number, minute: number) => string;
}

/** 定数 */
export const DRAG_CONSTANTS = {
  /** 長押し検出時間（Google/Apple標準: 300-500ms） */
  LONG_PRESS_DURATION: 300,
  /** 長押し中の許容水平移動距離（px） */
  LONG_PRESS_MOVE_THRESHOLD: 10,
  /**
   * 長押し中の許容垂直移動距離（px）。
   * Why: タイムラインは縦スクロールが主動線。水平より早く譲ることで、
   * スクロール中に長押しタイマーが先に発火して時間選択が誤って開始されるのを防ぐ。
   */
  LONG_PRESS_VERTICAL_THRESHOLD: 6,
  /** シングルタップの最大時間（ms） */
  SINGLE_TAP_MAX_DURATION: 200,
  /** ドラッグとみなす最小移動距離（px） */
  MIN_DRAG_DISTANCE: 5,
} as const;
