/**
 * Review Feature - Public API
 *
 * docs: docs/product/specs/review.md
 *
 * 振り返り機能のエントリポイント。
 * 内部モジュールへの直接参照（deep import）は避け、ここからのみ import すること。
 *
 * `/report`（Composition Layer）が唯一の consumer。期間の正本は URL（`?date=&range=`）で、
 * Composition Layer が解析して渡す。集計は review 自身の tRPC query が行う。
 *
 * ページ本体（`ReportBody`）は 1 export に保つ — 章を個別 export すると分析の置き場が
 * 増える。`ReportFilterList` は Sidebar 側のコンテンツでページ本体の一部ではないため、この
 * 歯止めの対象外（Sidebar の内容として別枠）。`ReportTabs` も面の切替でありページ本体ではない。
 */

// =============================================================================
// Components
// =============================================================================
export { ConnectedReportDetailPanel } from './components/detail/ConnectedReportDetailPanel';
export { ReportHeader } from './components/layout/ReportHeader';
export { ReportMobileHeader } from './components/layout/ReportMobileHeader';
export { ReportTabs } from './components/layout/ReportTabs';
export { ReportBody } from './components/report/ReportBody';
export { ReportFilterDrawer } from './components/sidebar/ReportFilterDrawer';
export { ReportFilterList } from './components/sidebar/ReportFilterList';

// =============================================================================
// Lib（期間とタブの契約 — Composition Layer が `?date=&range=&tab=` から面を組む）
// =============================================================================
export {
  isReportGranularity,
  resolveReportRange,
  resolveZonedDayKey,
  shiftReportAnchor,
  todayReportAnchor,
} from './lib/report-period';
export type { ReportGranularity } from './lib/report-period';
export { buildReportHref, parseReportTabParam } from './lib/report-tab';
export type { ReportTab } from './lib/report-tab';

// =============================================================================
// 詳細パネルの器（shell が 4 カラム目を用意するために要る）
// =============================================================================
export {
  REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
  REPORT_DETAIL_SLOT_KEY,
} from './lib/report-detail-slot';
export { useReportDetailStore } from './stores/useReportDetailStore';

// ここにないものはfeature内部専用
