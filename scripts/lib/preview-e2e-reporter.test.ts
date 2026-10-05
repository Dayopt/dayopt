import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import PreviewE2EReporter, { isPassingPreviewReport } from './preview-e2e-reporter.mjs';

const publicFlows = [
  { file: 'auth.spec.ts', flowId: 'product-auth-signup-page' },
  { file: 'auth.spec.ts', flowId: 'product-auth-login-page' },
  { file: 'auth.spec.ts', flowId: 'product-auth-password-page' },
  { file: 'pwa.spec.ts', flowId: 'product-pwa-manifest' },
  { file: 'smoke.spec.ts', flowId: 'product-smoke-unauth-redirect' },
  { file: 'smoke.spec.ts', flowId: 'product-smoke-en-signup-locale' },
  { file: 'smoke.spec.ts', flowId: 'product-smoke-ja-signup-locale' },
  { file: 'a11y.spec.ts', flowId: 'product-a11y-login' },
];

const authenticatedFlows = [
  {
    file: 'account-deletion.spec.ts',
    project: 'chromium',
    flowId: 'product-account-deletion',
  },
  {
    file: 'auth.spec.ts',
    project: 'chromium',
    flowId: 'product-auth-login-valid',
  },
  {
    file: 'auth.spec.ts',
    project: 'chromium',
    flowId: 'product-auth-login-invalid',
  },
  {
    file: 'a11y.spec.ts',
    project: 'chromium',
    flowId: 'product-a11y-calendar',
  },
  {
    file: 'a11y.spec.ts',
    project: 'chromium',
    flowId: 'product-a11y-settings',
  },
  {
    file: 'calendar-navigation.spec.ts',
    project: 'chromium',
    flowId: 'product-calendar-view-navigation',
  },
  {
    file: 'calendar-navigation.spec.ts',
    project: 'chromium',
    flowId: 'product-calendar-sidebar-navigation',
  },
  {
    file: 'block-search.spec.ts',
    project: 'chromium',
    flowId: 'product-search-desktop',
  },
  {
    file: 'block-search.spec.ts',
    project: 'Mobile Chrome',
    flowId: 'product-search-mobile',
  },
  {
    file: 'plan-record-timeblock.spec.ts',
    project: 'chromium',
    flowId: 'product-plan-record-calendar',
  },
  {
    file: 'plan-record-timeblock.spec.ts',
    project: 'chromium',
    flowId: 'product-record-inspector-url',
  },
  {
    file: 'deep-link.spec.ts',
    project: 'chromium',
    flowId: 'product-deep-link-week',
  },
  {
    file: 'deep-link.spec.ts',
    project: 'chromium',
    flowId: 'product-deep-link-prefixless',
  },
  {
    file: 'deep-link.spec.ts',
    project: 'chromium',
    flowId: 'product-deep-link-default-week',
  },
  {
    file: 'deep-link.spec.ts',
    project: 'chromium',
    flowId: 'product-deep-link-invalid-view',
  },
  {
    file: 'derived-plan-record-flow.spec.ts',
    project: 'chromium',
    flowId: 'product-derived-plan-record',
  },
  {
    file: 'timeblock-conflict.spec.ts',
    project: 'chromium',
    flowId: 'product-plan-conflict',
  },
  {
    file: 'timeblock-drag-move.spec.ts',
    project: 'chromium',
    flowId: 'product-plan-drag-move',
  },
  {
    file: 'timeblock-inspector-toggle.spec.ts',
    project: 'chromium',
    flowId: 'product-inspector-toggle',
  },
  {
    file: 'mobile-navigation.spec.ts',
    project: 'Mobile Chrome',
    flowId: 'product-mobile-settings-navigation',
  },
  {
    file: 'mobile-navigation.spec.ts',
    project: 'Mobile Chrome',
    flowId: 'product-mobile-calendar-navigation',
  },
  {
    file: 'billing.spec.ts',
    project: 'chromium',
    flowId: 'product-billing-checkout-mocked',
  },
  {
    file: 'billing.spec.ts',
    project: 'chromium',
    flowId: 'product-billing-portal-mocked',
  },
  {
    file: 'billing.spec.ts',
    project: 'chromium',
    flowId: 'product-billing-checkout-success-return',
  },
  {
    file: 'billing.spec.ts',
    project: 'chromium',
    flowId: 'product-billing-checkout-cancel-return',
  },
  {
    file: 'billing.spec.ts',
    project: 'chromium',
    flowId: 'product-billing-portal-return',
  },
  {
    file: 'calendar-initial-load.spec.ts',
    project: 'chromium',
    flowId: 'product-initial-desktop-tokyo',
  },
  {
    file: 'calendar-initial-load.spec.ts',
    project: 'chromium',
    flowId: 'product-initial-desktop-la',
  },
  {
    file: 'calendar-initial-load.spec.ts',
    project: 'Mobile Chrome',
    flowId: 'product-initial-mobile-tokyo',
  },
  {
    file: 'calendar-initial-load.spec.ts',
    project: 'Mobile Chrome',
    flowId: 'product-initial-mobile-la',
  },
];

function reviewedReport() {
  const desktop = [
    'desktop-plan-create',
    'desktop-record-create',
    'desktop-past-plan-create',
    'desktop-summary-known-records',
    'desktop-summary-record-deep-link',
    'desktop-summary-empty',
    'desktop-settings-display',
    'desktop-data-export',
    'desktop-activity-lifecycle',
    'desktop-theme',
    'desktop-timezone',
    'desktop-locale',
    'desktop-category-lifecycle',
    'desktop-inspector-search',
    'desktop-plan-move',
    'desktop-conflict-merge',
    'desktop-template-lifecycle',
  ];
  const mobile = [
    'mobile-plan-create',
    'mobile-record-create',
    'mobile-summary-to-inspector',
    'mobile-settings-display',
  ];
  const tests = [
    ...desktop.map((flowId) => ({ file: 'critical-path.spec.ts', project: 'chromium', flowId })),
    ...mobile.map((flowId) => ({
      file: 'mobile-critical-path.spec.ts',
      project: 'Mobile Chrome',
      flowId,
    })),
    ...publicFlows.map((flow) => ({ ...flow, project: 'chromium' })),
    ...authenticatedFlows,
  ].map((row, index) => ({
    ...row,
    line: index + 1,
    status: 'passed',
    expectedPassed: true,
    retry: 0,
  }));
  return { status: 'passed', expected: 59, tests };
}

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe('Preview reviewed Product acceptance scope', () => {
  it('requires all fifty-nine reviewed flows and rejects the previous twenty-nine-flow report', () => {
    expect(isPassingPreviewReport(reviewedReport())).toBe(true);
    const previous = reviewedReport();
    previous.tests.splice(29);
    previous.expected = 29;
    expect(isPassingPreviewReport(previous)).toBe(false);
  });

  it.each([...publicFlows.map((row) => ({ ...row, project: 'chromium' })), ...authenticatedFlows])(
    'requires $flowId on its reviewed file and desktop project',
    (flow) => {
      const report = reviewedReport();
      const row = report.tests.find((test) => test.flowId === flow.flowId)!;
      row.project = flow.project === 'chromium' ? 'Mobile Chrome' : 'chromium';
      expect(isPassingPreviewReport(report)).toBe(false);
      row.project = flow.project;
      row.file = 'critical-path.spec.ts';
      expect(isPassingPreviewReport(report)).toBe(false);
      row.file = flow.file;
      row.status = 'skipped';
      expect(isPassingPreviewReport(report)).toBe(false);
      row.status = 'passed';
      row.retry = 1;
      expect(isPassingPreviewReport(report)).toBe(false);
      row.retry = 0;
      row.flowId = 'product-unreviewed-flow';
      expect(isPassingPreviewReport(report)).toBe(false);
    },
  );

  it.each(['@preview-e2e/', 'preview-e2e/'])(
    'records public declarations tagged with %s',
    (prefix) => {
      const directory = mkdtempSync(join(tmpdir(), 'preview-public-reporter-'));
      directories.push(directory);
      const reporter = new PreviewE2EReporter({ directory });
      const report = reviewedReport();
      reporter.onBegin({}, { allTests: () => report.tests });
      for (const row of report.tests) {
        reporter.onTestEnd(
          {
            id: row.flowId,
            location: { file: row.file, line: row.line },
            parent: { project: () => ({ name: row.project }) },
            tags: [`${prefix}${row.flowId}`],
            expectedStatus: 'passed',
          },
          {
            status: 'passed',
            duration: 1,
            retry: 0,
            attachments: [
              {
                name: 'preview-network',
                body: Buffer.from(JSON.stringify([{ at: 1, target: 'preview', status: 200 }])),
              },
            ],
          },
        );
      }
      expect(reporter.onEnd({ status: 'passed' })).toEqual({ status: 'passed' });
      const evidence = JSON.parse(readFileSync(join(directory, 'e2e.json'), 'utf8'));
      expect(evidence.tests).toHaveLength(59);
      expect(evidence.tests.slice(21).map((row: { flowId: string }) => row.flowId)).toEqual(
        [...publicFlows, ...authenticatedFlows].map((flow) => flow.flowId),
      );
    },
  );
});
