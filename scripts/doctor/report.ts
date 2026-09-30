import { sanitize } from './safety.ts';
import type { Result } from './types.ts';

export function exitCode(results: Result[]): number {
  if (results.some((result) => result.status === 'drift')) return 1;
  if (results.some((result) => result.required && ['blocked', 'manual'].includes(result.status)))
    return 2;
  return 0;
}
export function renderReport(
  results: Result[],
  format: 'text' | 'json',
  metadata: Record<string, unknown>,
): string {
  const counts = Object.fromEntries(
    ['pass', 'drift', 'blocked', 'manual', 'not_applicable'].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const report = sanitize({
    version: 1,
    ...metadata,
    exit_code: exitCode(results),
    counts,
    results,
  }) as Record<string, unknown>;
  if (format === 'json') return JSON.stringify(report, null, 2);
  const safeResults = report.results as Result[];
  return [
    'Dayopt infrastructure doctor（読み取り専用）',
    JSON.stringify(report.counts),
    ...safeResults.map(
      (result) =>
        `[${result.status}] ${result.check_id} (${result.environment})\n  期待: ${JSON.stringify(result.expected)}\n  実測: ${JSON.stringify(result.observed)}\n  取得元: ${result.source} / ${result.checked_at}\n  理由: ${result.reason}\n  次: ${result.next_step}`,
    ),
    `終了コード: ${exitCode(results)}（判定不能は正常に含めません）`,
    `Advisories: ${JSON.stringify(report.advisories ?? [])}`,
  ].join('\n');
}
