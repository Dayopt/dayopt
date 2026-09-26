/**
 * インタラクション関連のヘルパー関数
 *
 * DayContent / WeekContent / MultiDayContent で共通使用される
 * ドラッグ・リサイズ中のスタイル調整とプレビュー時刻の取得。
 */

import type React from 'react';

import type { InteractionState } from '../../../../interaction';

/**
 * ドラッグ・リサイズ中のプランスタイルを調整する
 * @param originalStyle - 元のCSSスタイル
 * @param planId - 対象プランのID
 * @param state - 現在のインタラクション状態
 */
export function getAdjustedStyle(
  originalStyle: React.CSSProperties,
  planId: string,
  state: InteractionState,
): React.CSSProperties {
  if (state.mode === 'dragging' && state.timeblockId === planId) {
    return { ...originalStyle, opacity: 0.3, zIndex: 1 };
  }
  if (state.mode === 'resizing' && state.timeblockId === planId) {
    return {
      ...originalStyle,
      top: state.snappedTop,
      height: `${state.snappedHeight}px`,
      zIndex: 1000,
    };
  }
  return originalStyle;
}

/**
 * リサイズ中のプレビュー時刻を取得する（ドラッグ時はゴースト側に表示）
 * @param planId - 対象プランのID
 * @param state - 現在のインタラクション状態
 * @returns リサイズ中の場合はプレビュー時刻、それ以外はnull
 */
export function getPreviewTime(
  planId: string,
  state: InteractionState,
): { start: Date; end: Date } | null {
  if (state.mode === 'resizing' && state.timeblockId === planId) {
    return state.previewTime;
  }
  return null;
}
