import { describe, expect, it } from 'vitest';

import { buildReportHref, parseReportTabParam, reportTabs } from './report-tab';

describe('parseReportTabParam', () => {
  it.each(reportTabs)('%s is accepted as a report tab', (tab) => {
    expect(parseReportTabParam(tab)).toBe(tab);
  });

  it('省略と不正値は時間の使い方へ丸める', () => {
    expect(parseReportTabParam(undefined)).toBe('usage');
    expect(parseReportTabParam('tidy')).toBe('usage');
    expect(parseReportTabParam('')).toBe('usage');
  });
});

describe('buildReportHref', () => {
  it('既定タブでは tab= を書かない', () => {
    expect(buildReportHref({ anchorDate: '2026-09-02', granularity: 'week', tab: 'usage' })).toBe(
      '/report?date=2026-09-02&range=week',
    );
  });

  it('既定以外のタブは期間と一緒に書く', () => {
    expect(buildReportHref({ anchorDate: '2026-09-02', granularity: 'month', tab: 'diff' })).toBe(
      '/report?date=2026-09-02&range=month&tab=diff',
    );
  });
});
