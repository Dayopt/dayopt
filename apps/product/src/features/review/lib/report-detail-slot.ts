/**
 * DesktopLayout の 4 カラム目（右）へ詳細パネルを portal するための DOM slot key と幅。
 *
 * timeblock inspector（400px）とは**別の slot**にする。inspector（timeblock / L1）と
 * report detail（review / L2）は別ページに属し同時に開かないので、1 つの slot を共有すると
 * 「どちらを描くか」の調停ロジックを shell に置くことになる。その調停に価値が無く、幅も違う。
 * 3 つ目のパネルが要求された時点で汎用化を再検討する（#2581 の判断）。
 */
export const REPORT_DETAIL_SLOT_KEY = 'report-detail-panel';

/** 詳細パネルの既定幅（px）。分布と推移が読める最小の幅として選んだ。 */
export const REPORT_DETAIL_PANEL_DEFAULT_WIDTH = 360;

/** 下限（px）。これ以下だと明細の時刻・長さ・充実が 1 行に収まらない。 */
export const REPORT_DETAIL_PANEL_MIN_WIDTH = 250;

/** 上限（px）。カレンダー / 章の面を潰さないための天井。 */
export const REPORT_DETAIL_PANEL_MAX_WIDTH = 560;

/** キーボードで幅を変える時の 1 打あたりの量（px）。 */
export const REPORT_DETAIL_PANEL_RESIZE_STEP = 16;

/**
 * 幅を許容範囲へ収める。非有限値（`NaN` / `Infinity`）は既定へ倒す。
 *
 * localStorage の値も、ドラッグ中の計算結果も、必ずここを通す。片方だけ通すと「保存された
 * 壊れた値でパネルが消える」が起きる。
 */
export function clampReportDetailPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return REPORT_DETAIL_PANEL_DEFAULT_WIDTH;
  return Math.min(
    REPORT_DETAIL_PANEL_MAX_WIDTH,
    Math.max(REPORT_DETAIL_PANEL_MIN_WIDTH, Math.round(width)),
  );
}
