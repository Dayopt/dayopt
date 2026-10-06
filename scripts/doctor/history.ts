import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitize } from './safety.ts';
import type { Environment, Result } from './types.ts';

const MAX_BYTES = 4 * 1024 * 1024;
const STATUSES = new Set(['pass', 'drift', 'blocked', 'manual', 'not_applicable']);
type SafeReport = {
  version: number;
  mode: string;
  repo_revision?: string;
  expectation_revision?: string;
  expected_fingerprint?: string;
  contract_fingerprint?: string;
  comparison_available?: boolean;
  comparison_reason?: string;
  history_changes?: ReturnType<typeof compareResults>;
  history_design_changed?: boolean;
  checked_at_jst?: string;
  exit_code: number;
  counts: Record<string, number>;
  results: Result[];
};
export type HistoryRecord = SafeReport & {
  recorded_at: string;
  scope: { service: string | null; environment: Environment };
};

function validReport(value: unknown): value is SafeReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<SafeReport>;
  const counts = report.counts;
  const results = report.results;
  if (
    report.version !== 1 ||
    report.mode !== 'live_read_only' ||
    !Number.isInteger(report.exit_code) ||
    ![0, 1, 2].includes(report.exit_code!) ||
    !counts ||
    typeof counts !== 'object' ||
    !['pass', 'drift', 'blocked', 'manual', 'not_applicable'].every(
      (key) => Number.isInteger(counts[key]) && counts[key] >= 0,
    ) ||
    !Array.isArray(results) ||
    results.length === 0 ||
    results.length > 10000 ||
    new Set(results.map((result) => `${result?.check_id}\0${result?.environment}`)).size !==
      results.length ||
    typeof report.repo_revision !== 'string' ||
    typeof report.expectation_revision !== 'string' ||
    typeof report.expected_fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(report.expected_fingerprint) ||
    typeof report.contract_fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(report.contract_fingerprint) ||
    (report.comparison_available !== undefined &&
      typeof report.comparison_available !== 'boolean') ||
    (report.comparison_reason !== undefined && report.comparison_reason !== 'no_previous_record') ||
    (report.history_design_changed !== undefined &&
      typeof report.history_design_changed !== 'boolean') ||
    (report.history_changes !== undefined &&
      (!Array.isArray(report.history_changes) ||
        report.history_changes.some(
          (change) =>
            !change ||
            typeof change.check_id !== 'string' ||
            typeof change.kind !== 'string' ||
            (change.reason !== undefined && typeof change.reason !== 'string') ||
            (change.next_step !== undefined && typeof change.next_step !== 'string'),
        )))
  )
    return false;
  const actualCounts = { pass: 0, drift: 0, blocked: 0, manual: 0, not_applicable: 0 };
  for (const result of results) {
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.check_id !== 'string' ||
      result.check_id.length === 0 ||
      typeof result.service !== 'string' ||
      typeof result.environment !== 'string' ||
      !STATUSES.has(result.status) ||
      !('expected' in result) ||
      !('observed' in result) ||
      typeof result.reason !== 'string' ||
      typeof result.next_step !== 'string' ||
      typeof result.checked_at !== 'string' ||
      typeof result.source !== 'string' ||
      typeof result.required !== 'boolean'
    )
      return false;
    actualCounts[result.status as keyof typeof actualCounts]++;
  }
  if (Object.entries(actualCounts).some(([key, count]) => counts[key] !== count)) return false;
  const calculatedExit =
    actualCounts.drift > 0
      ? 1
      : results.some((result) => result.required && ['blocked', 'manual'].includes(result.status))
        ? 2
        : 0;
  return report.exit_code === calculatedExit;
}
function projectReport(value: SafeReport): SafeReport {
  return sanitize({
    version: value.version,
    mode: value.mode,
    repo_revision: value.repo_revision,
    expectation_revision: value.expectation_revision,
    expected_fingerprint: value.expected_fingerprint,
    contract_fingerprint: value.contract_fingerprint,
    ...(value.comparison_available !== undefined
      ? { comparison_available: value.comparison_available }
      : {}),
    ...(value.comparison_reason ? { comparison_reason: value.comparison_reason } : {}),
    ...(value.history_changes
      ? {
          history_changes: value.history_changes.map((change) => ({
            check_id: change.check_id,
            kind: change.kind,
            ...(change.environment ? { environment: change.environment } : {}),
            ...(change.status ? { status: change.status } : {}),
            ...(change.reason ? { reason: change.reason } : {}),
            ...(change.next_step ? { next_step: change.next_step } : {}),
          })),
        }
      : {}),
    ...(value.history_design_changed ? { history_design_changed: true } : {}),
    checked_at_jst: value.checked_at_jst,
    exit_code: value.exit_code,
    counts: Object.fromEntries(
      ['pass', 'drift', 'blocked', 'manual', 'not_applicable'].map((key) => [
        key,
        value.counts[key],
      ]),
    ),
    ...(Array.isArray((value as SafeReport & { advisories?: unknown }).advisories)
      ? { advisories: (value as SafeReport & { advisories: unknown[] }).advisories }
      : {}),
    results: value.results.map((result) => ({
      check_id: result.check_id,
      service: result.service,
      environment: result.environment,
      expected: result.expected,
      observed: result.observed,
      source: result.source,
      checked_at: result.checked_at,
      status: result.status,
      reason: result.reason,
      next_step: result.next_step,
      required: result.required,
    })),
  }) as SafeReport;
}
function safeDirectory(root: string) {
  return join(root, '.local', 'infra-doctor', 'history');
}
async function ensureDirectory(root: string) {
  const base = join(root, '.local');
  const parent = join(base, 'infra-doctor');
  for (const directory of [base, parent, safeDirectory(root)]) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_history_path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(directory, { mode: 0o700 });
    }
  }
  await chmod(safeDirectory(root), 0o700);
}
export function expectedFingerprint(root: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, 'docs/engineering/infra/expected.yaml')))
    .digest('hex');
}
export async function saveHistory(
  root: string,
  rawReport: string,
  service: string | null,
  environment: Environment,
) {
  if (Buffer.byteLength(rawReport) > MAX_BYTES) throw new Error('history_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawReport);
  } catch {
    throw new Error('history_invalid_report');
  }
  if (!validReport(parsed)) throw new Error('history_invalid_report');
  const safeReport = projectReport(parsed);
  await ensureDirectory(root);
  const recorded: HistoryRecord = sanitize({
    ...safeReport,
    scope: { service, environment },
    recorded_at: new Date().toISOString(),
  }) as HistoryRecord;
  const filename = `${Date.now()}-${randomUUID()}.json`;
  const path = join(safeDirectory(root), filename);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(recorded, null, 2) + '\n');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return path;
}
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item))
      return item.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
export function compareResults(previous: Result[], current: Result[]) {
  const identity = (result: Result) => `${result.check_id}\0${result.environment}`;
  const stableCheckId = (result: Result) =>
    result.check_id.endsWith(`:${result.environment}`)
      ? result.check_id.slice(0, -`:${result.environment}`.length)
      : result.check_id;
  const before = new Map(previous.map((result) => [identity(result), result]));
  const after = new Map(current.map((result) => [identity(result), result]));
  const changes: {
    check_id: string;
    environment?: string;
    kind: string;
    status?: string;
    reason?: string;
    next_step?: string;
  }[] = [];
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (!prev)
      changes.push({
        check_id: stableCheckId(next),
        environment: next.environment,
        kind: 'added',
        status: next.status,
        reason: next.reason,
        next_step: next.next_step,
      });
    else {
      const detail = {
        check_id: stableCheckId(next),
        environment: next.environment,
        status: next.status,
        reason: next.reason,
        next_step: next.next_step,
      };
      if (prev.status !== next.status) changes.push({ ...detail, kind: 'status_changed' });
      if (canonical(prev.expected) !== canonical(next.expected))
        changes.push({ ...detail, kind: 'expected_changed' });
      if (canonical(prev.observed) !== canonical(next.observed))
        changes.push({ ...detail, kind: 'observed_changed' });
      if (prev.reason !== next.reason) changes.push({ ...detail, kind: 'reason_changed' });
    }
  }
  for (const [id, prev] of before)
    if (!after.has(id))
      changes.push({
        check_id: stableCheckId(prev),
        environment: prev.environment,
        kind: 'removed',
        reason: 'check_no_longer_present',
      });
  return changes.sort(
    (a, b) => a.check_id.localeCompare(b.check_id) || a.kind.localeCompare(b.kind),
  );
}
export async function readHistory(root: string, service: string | null, environment: Environment) {
  const directory = safeDirectory(root);
  for (const candidate of [join(root, '.local'), join(root, '.local', 'infra-doctor'), directory]) {
    try {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('history_invalid_path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { records: [], changes: [], designChanged: false, empty: true };
      throw new Error('history_unavailable');
    }
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [], changes: [], designChanged: false, empty: true };
    throw new Error('history_unavailable');
  }
  const records: HistoryRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      throw new Error('history_invalid_file');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('history_invalid_file');
    }
    const rawRecord = parsed as HistoryRecord;
    if (
      !validReport(parsed) ||
      !rawRecord.scope ||
      typeof rawRecord.scope !== 'object' ||
      !(rawRecord.scope.service === null || typeof rawRecord.scope.service === 'string') ||
      !['all', 'production', 'preview', 'integration'].includes(rawRecord.scope.environment) ||
      typeof rawRecord.recorded_at !== 'string' ||
      Number.isNaN(Date.parse(rawRecord.recorded_at))
    )
      throw new Error('history_invalid_file');
    const record = sanitize({
      ...projectReport(rawRecord),
      scope: { service: rawRecord.scope.service, environment: rawRecord.scope.environment },
      recorded_at: rawRecord.recorded_at,
    }) as HistoryRecord;
    if (record.scope.service === service && record.scope.environment === environment)
      records.push(record);
  }
  records.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const latest = records.slice(0, 2);
  const changes = latest.length === 2 ? compareResults(latest[1].results, latest[0].results) : [];
  const designChanged =
    latest.length === 2 &&
    (latest[0].expected_fingerprint !== latest[1].expected_fingerprint ||
      latest[0].contract_fingerprint !== latest[1].contract_fingerprint);
  return { records: latest, changes, designChanged, empty: latest.length === 0 };
}
export function historySummary(
  data: Awaited<ReturnType<typeof readHistory>>,
  format: 'text' | 'json',
) {
  const shape = {
    mode: 'history_read_only',
    network_attempted: false,
    empty: data.empty,
    design_changed: data.designChanged ?? false,
    records: data.records.map((record) => ({
      recorded_at: record.recorded_at,
      repo_revision: record.repo_revision ?? 'unknown',
      expectation_revision: record.expectation_revision ?? 'unknown',
      expected_fingerprint: record.expected_fingerprint ?? 'unknown',
      contract_fingerprint: record.contract_fingerprint ?? 'unknown',
      comparison_available: record.comparison_available ?? false,
      comparison_reason: record.comparison_reason ?? 'no_previous_record',
      exit_code: record.exit_code,
      counts: record.counts,
    })),
    changes: data.changes,
    comparison_available: data.records.length > 1,
    comparison_reason: data.records.length > 1 ? undefined : 'no_previous_record',
  };
  const safeShape = sanitize(shape);
  return format === 'json'
    ? JSON.stringify(safeShape, null, 2)
    : data.empty
      ? '履歴はありません（状態は未確認です）。'
      : `保存履歴: ${shape.records.length}件\n${(safeShape as typeof shape).records.map((record, i) => `${i === 0 ? '最新' : '前回'} ${record.recorded_at} exit=${record.exit_code} ${JSON.stringify(record.counts)} expected=${record.expected_fingerprint} contracts=${record.contract_fingerprint}`).join('\n')}\n変化: ${data.records.length < 2 ? '未比較（前回記録なし）' : data.changes.length ? (safeShape as typeof shape).changes.map((item) => `${item.kind}:${item.check_id}${item.environment ? ` (${item.environment})` : ''}${item.reason ? ` (${item.reason})` : ''}${item.next_step ? ` → ${item.next_step}` : ''}`).join(', ') : 'なし'}${data.designChanged ? '\n設計変更: expected.yamlまたは登録source contract fingerprintが変化しました（実測driftとは別の情報）' : ''}${data.records.length > 1 && data.changes.length ? '\n次の確認: ' + ((safeShape as typeof shape).changes.find((item) => item.next_step)?.next_step ?? '差分の理由を確認してください') : ''}`;
}
