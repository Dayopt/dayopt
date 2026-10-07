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
    `実行repo: ${report.repo_revision ?? 'unknown'}`,
    `期待値baseline: ${report.expectation_revision ?? 'unknown'}`,
    `確認日時: ${report.checked_at_jst ?? 'unknown'}`,
    ...(report.expected_fingerprint ? [`期待値fingerprint: ${report.expected_fingerprint}`] : []),
    ...(report.contract_fingerprint ? [`契約fingerprint: ${report.contract_fingerprint}`] : []),
    ...(report.history_saved_path ? [`保存先: ${report.history_saved_path}`] : []),
    ...(report.history_saved === false
      ? [`履歴保存: 失敗 (${report.history_error ?? 'history_unavailable'})`]
      : []),
    ...(report.comparison_available === false
      ? [`前回比較: なし (${report.comparison_reason ?? '理由不明'})`]
      : []),
    ...(report.comparison_available === true ? ['前回比較: 可能'] : []),
    ...(report.history_design_changed
      ? ['設計変更: expected.yamlまたはsource contract fingerprintが変化']
      : []),
    ...(report.comparison_available === false
      ? [`前回からの変化: 未比較 (${report.comparison_reason ?? 'no_previous_record'})`]
      : Array.isArray(report.history_changes)
        ? [
            `前回からの変化: ${(report.history_changes as { kind: string; check_id: string }[]).map((change) => `${change.kind}:${change.check_id}`).join(', ') || 'なし'}`,
          ]
        : []),
    JSON.stringify(report.counts),
    ...safeResults.map(
      (result) =>
        `[${result.status}] ${result.check_id} (${result.environment})\n  期待: ${JSON.stringify(result.expected)}\n  実測: ${JSON.stringify(result.observed)}\n  取得元: ${result.source} / ${result.checked_at}\n  理由: ${result.reason}\n  次: ${result.next_step}`,
    ),
    `終了コード: ${exitCode(results)}（判定不能は正常に含めません）`,
    `Advisories: ${JSON.stringify(report.advisories ?? [])}`,
  ].join('\n');
}
