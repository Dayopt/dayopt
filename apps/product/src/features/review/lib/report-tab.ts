/**
 * レポートのタブ（目的ごとの面）。
 *
 * | tab       | 読むもの                                 |
 * | --------- | ---------------------------------------- |
 * | `usage`   | 時間の使い方 — 何にいくら使ったか（事実）    |
 * | `diff`    | 差分 — 予定と記録はどう違ったか          |
 * | `reflect` | 振り返り — それは良い使い方だったか      |
 *
 * **配列の順序がそのままタブの並び**になる。先頭が既定。期間（`date` / `range`）とは独立した
 * 軸で、URL の `?tab=` に持つ（共有リンクで同じ面が開くように）。
 */
export const reportTabs = ['usage', 'diff', 'reflect'] as const;
export type ReportTab = (typeof reportTabs)[number];

const DEFAULT_REPORT_TAB: ReportTab = 'usage';

function isReportTab(value: unknown): value is ReportTab {
  return typeof value === 'string' && (reportTabs as readonly string[]).includes(value);
}

/** `?tab=` を解釈する。省略・不正値は既定へ丸める（既存の `/report` リンクを壊さない）。 */
export function parseReportTabParam(tab: string | undefined): ReportTab {
  return isReportTab(tab) ? tab : DEFAULT_REPORT_TAB;
}

/**
 * `/report` の URL を組む。
 *
 * 既定タブは `tab=` を書かない。粒度切替とタブ切替の両方がここを通るので、片方の操作で
 * もう片方の軸が URL から落ちることが無い。
 */
export function buildReportHref(options: {
  anchorDate: string;
  granularity: string;
  tab: ReportTab;
}): string {
  const params = new URLSearchParams({ date: options.anchorDate, range: options.granularity });
  if (options.tab !== DEFAULT_REPORT_TAB) params.set('tab', options.tab);
  return `/report?${params.toString()}`;
}
