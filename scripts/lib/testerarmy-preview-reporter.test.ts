import { expect, it } from 'vitest';
import {
  isPassingTesterArmyPreviewReport,
  sanitizeTesterArmyReport,
} from './testerarmy-preview-reporter.mjs';

function passing() {
  return {
    schemaVersion: 'report-1',
    run: {
      status: 'passed',
      exitCode: 0,
      errors: [],
      targets: [{ id: 'product-authenticated' }],
      summary: {
        discovered: 3,
        selected: 3,
        executed: 3,
        passed: 3,
        failed: 0,
        skipped: 0,
        flaky: 0,
        interrupted: 0,
      },
      results: [0, 1, 2].map((declarationIndex) => ({
        kind: 'test',
        file: 'testerarmy/journey.e2e.ts',
        targetId: 'product-authenticated',
        selected: true,
        status: 'passed',
        repeat: 0,
        declarationIndex,
        titlePath: ['secret-title'],
        attempts: [{ index: 0, status: 'passed', secondaryErrors: [], cleanup: 'complete' }],
      })),
    },
  };
}
const networks = [0, 1, 2].map(() => [
  { target: 'preview', at: 1, status: 200, secret: 'do-not-retain' },
]);

it('accepts complete honest TesterArmy evidence and drops title/network secret fields', () => {
  expect(isPassingTesterArmyPreviewReport(sanitizeTesterArmyReport(null, networks))).toBe(false);
  const result = sanitizeTesterArmyReport(passing(), networks);
  expect(isPassingTesterArmyPreviewReport(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('rejects missing tests, skips, retries, wrong target, wrong file and malformed network', () => {
  const mutations = [
    (r: any) => (r.run.targets[0] = null),
    (r: any) => (r.run.results[0].attempts[0] = null),
    (r: any) => (r.run.results[0].declarationIndex = null),
    (r: any) => (r.run.results[0].declarationIndex = '0'),
    (r: any) => (r.run.results[0].declarationIndex = 50),
    (r: any) => (r.run.results[0] = null),
    (r: any) => r.run.results.pop(),
    (r: any) => (r.run.results[0].status = 'skipped'),
    (r: any) => r.run.results[0].attempts.push(r.run.results[0].attempts[0]),
    (r: any) => (r.run.results[0].file = 'critical-path.spec.ts'),
    (r: any) => (r.run.targets[0].id = 'chromium'),
    (r: any) => (r.run.summary.skipped = 1),
    (r: any) => (r.run.results[0].attempts[0].cleanup = 'failed'),
  ];
  for (const mutate of mutations) {
    const report = passing();
    mutate(report);
    expect(isPassingTesterArmyPreviewReport(sanitizeTesterArmyReport(report, networks))).toBe(
      false,
    );
  }
  expect(isPassingTesterArmyPreviewReport(sanitizeTesterArmyReport(passing(), []))).toBe(false);
  expect(
    isPassingTesterArmyPreviewReport(
      sanitizeTesterArmyReport(passing(), [
        [{ target: 'unknown', at: 1, status: 200 }],
        ...networks.slice(1),
      ]),
    ),
  ).toBe(false);
});
