import { describe, expect, it } from 'vitest';

import {
  classifyReport,
  renderAnnotations,
  renderSummary,
  resolveExitCode,
} from './e2e-retry-report.mjs';

/**
 * Playwright JSON reporter の形（playwright/types/testReporter.d.ts の JSONReport）を
 * 最小に写した fixture。file suite → describe suite の入れ子と、4 種の test.status を持つ。
 */
const report = {
  suites: [
    {
      title: 'critical-path.spec.ts',
      file: 'critical-path.spec.ts',
      specs: [],
      suites: [
        {
          title: 'Critical Path',
          file: 'critical-path.spec.ts',
          specs: [
            {
              title: 'Plan を作成できる',
              file: 'critical-path.spec.ts',
              line: 203,
              tests: [
                {
                  projectName: 'chromium',
                  status: 'flaky',
                  results: [
                    {
                      status: 'failed',
                      retry: 0,
                      error: {
                        message:
                          '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: …',
                      },
                    },
                    { status: 'passed', retry: 1 },
                  ],
                },
              ],
            },
            {
              title: 'Record を作成できる',
              file: 'critical-path.spec.ts',
              line: 229,
              tests: [
                {
                  projectName: 'chromium',
                  status: 'expected',
                  results: [{ status: 'passed', retry: 0 }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'mobile-critical-path.spec.ts',
      file: 'mobile-critical-path.spec.ts',
      specs: [
        {
          title: 'Report に反映される',
          file: 'mobile-critical-path.spec.ts',
          line: 40,
          tests: [
            {
              projectName: 'Mobile Chrome',
              status: 'unexpected',
              results: [
                { status: 'failed', retry: 0 },
                { status: 'failed', retry: 1 },
                { status: 'failed', retry: 2 },
              ],
            },
            { projectName: 'chromium', status: 'skipped', results: [] },
          ],
        },
      ],
    },
  ],
};

describe('classifyReport', () => {
  it('test.status で first-pass / retry-pass / failed / skipped に分ける', () => {
    const classified = classifyReport(report);
    expect(classified.firstPass.map((t) => t.title)).toEqual([
      'Critical Path › Record を作成できる',
    ]);
    expect(classified.retryPassed).toEqual([
      {
        title: 'Critical Path › Plan を作成できる',
        projectName: 'chromium',
        file: 'critical-path.spec.ts',
        line: 203,
        attempts: 2,
        passedOn: 2,
        firstError: 'Error: expect(locator).toBeVisible() failed',
      },
    ]);
    expect(classified.failed.map((t) => [t.projectName, t.title])).toEqual([
      ['Mobile Chrome', 'Report に反映される'],
    ]);
    expect(classified.skipped).toHaveLength(1);
  });

  it('suites 配列が無いものは report と見なさず throw する', () => {
    expect(() => classifyReport({})).toThrow(/suites/);
    expect(() => classifyReport(null)).toThrow(/suites/);
  });
});

describe('renderSummary', () => {
  it('件数表と retry-pass の行（passed on N/M と最初のエラー）を出す', () => {
    const summary = renderSummary(classifyReport(report), { label: 'product' });
    expect(summary).toContain('## E2E retry report (product)');
    expect(summary).toContain('| 1 | 1 | 1 | 1 |');
    expect(summary).toContain(
      '| chromium | Critical Path › Plan を作成できる (`critical-path.spec.ts:203`) | 2/2 | Error: expect(locator).toBeVisible() failed |',
    );
    expect(summary).toContain('- Mobile Chrome › Report に反映される');
  });

  it('retry-pass が無い時はその旨を 1 行で書く', () => {
    const summary = renderSummary(
      { firstPass: [], retryPassed: [], failed: [], skipped: [] },
      { label: 'web' },
    );
    expect(summary).toContain('retry で救済された test はありません。');
    expect(summary).not.toContain('### Retry-passed');
  });
});

describe('renderAnnotations', () => {
  it('retry-pass 1 件につき warning 注釈を 1 行、file prefix 付きで出す', () => {
    const annotations = renderAnnotations(classifyReport(report), {
      filePrefix: 'apps/product/src/lib/test/e2e/',
    });
    expect(annotations).toEqual([
      '::warning file=apps/product/src/lib/test/e2e/critical-path.spec.ts,line=203,title=E2E retry-pass::chromium › Critical Path › Plan を作成できる passed on attempt 2 of 2',
    ]);
  });
});

describe('resolveExitCode', () => {
  it('retry-pass があっても JSON を読めれば 0（retry-pass で promote を止めない）', () => {
    expect(resolveExitCode({ jsonPresent: true, parsed: true, testOutcome: 'success' })).toEqual({
      exitCode: 0,
      message: null,
    });
  });

  it('E2E が success なのに JSON が無いと 1（reporter 消失で retry-pass が見えなくなるのを防ぐ）', () => {
    const result = resolveExitCode({ jsonPresent: false, parsed: false, testOutcome: 'success' });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/^::error::/);
  });

  it('E2E が失敗・cancel して JSON が無い時は notice で 0（job は既に赤）', () => {
    for (const testOutcome of ['failure', 'cancelled', undefined]) {
      const result = resolveExitCode({ jsonPresent: false, parsed: false, testOutcome });
      expect(result.exitCode).toBe(0);
      expect(result.message).toMatch(/^::notice::/);
    }
  });

  it('JSON が壊れていると 1', () => {
    expect(
      resolveExitCode({ jsonPresent: true, parsed: false, testOutcome: 'failure' }).exitCode,
    ).toBe(1);
  });
});
