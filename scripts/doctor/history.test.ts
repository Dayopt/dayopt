import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { historySummary, readHistory, saveHistory } from './history.ts';
import type { Result } from './types.ts';

const result = (id: string, updates: Partial<Result> = {}): Result => ({
  check_id: id,
  service: 'svc',
  environment: 'production',
  expected: { a: 1, b: 2 },
  observed: { a: 1, b: 2 },
  source: 'reader',
  checked_at: 'one',
  status: 'pass',
  reason: 'ok',
  next_step: 'inspect',
  required: true,
  ...updates,
});
function report(results: Result[], fingerprint = 'a'.repeat(64)) {
  const counts = Object.fromEntries(
    ['pass', 'drift', 'blocked', 'manual', 'not_applicable'].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const exit_code = counts.drift
    ? 1
    : results.some((result) => result.required && ['blocked', 'manual'].includes(result.status))
      ? 2
      : 0;
  return JSON.stringify({
    version: 1,
    mode: 'live_read_only',
    repo_revision: 'rev',
    expectation_revision: 'base',
    expected_fingerprint: fingerprint,
    contract_fingerprint: 'b'.repeat(64),
    checked_at_jst: 'today',
    exit_code,
    counts,
    results,
  });
}
async function fixture() {
  return mkdtemp(join(tmpdir(), 'doctor-history-'));
}
describe('doctor history', () => {
  it('stores sanitized reports with private file and directory permissions', async () => {
    const root = await fixture();
    const path = await saveHistory(
      root,
      report([
        result('svc.check', {
          observed: 'https://FAKE_USER:FAKE_PASS@example.test/path?token=secret',
        }),
      ]),
      null,
      'all',
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, '.local', 'infra-doctor', 'history'))).mode & 0o777).toBe(0o700);
    const content = await readFile(path, 'utf8');
    for (const secret of ['FAKE_USER', 'FAKE_PASS', 'token=secret', 'example.test/path'])
      expect(content).not.toContain(secret);
  });
  it('preserves unknown-state run exit codes instead of treating them as healthy', async () => {
    const root = await fixture();
    const unknown = JSON.stringify({
      ...JSON.parse(
        report([result('blocked', { status: 'blocked', reason: 'permission_denied' })]),
      ),
      exit_code: 2,
    });
    await saveHistory(root, unknown, null, 'all');
    expect((await readHistory(root, null, 'all')).records[0].exit_code).toBe(2);
  });
  it('compares matching scope only and ignores checked timestamps', async () => {
    const root = await fixture();
    await saveHistory(root, report([result('same', { checked_at: 'earlier' })]), null, 'all');
    await saveHistory(root, report([result('same', { checked_at: 'later' })]), null, 'all');
    await saveHistory(root, report([result('different')]), 'svc', 'production');
    const data = await readHistory(root, null, 'all');
    expect(data.records).toHaveLength(2);
    expect(data.changes).toEqual([]);
    expect((await readHistory(root, 'svc', 'production')).records).toHaveLength(1);
  });
  it('classifies observation, expectation, reason, added, and removed changes', async () => {
    const root = await fixture();
    await saveHistory(root, report([result('same'), result('removed')]), null, 'all');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveHistory(
      root,
      report(
        [
          result('same', {
            status: 'drift',
            expected: { a: 2 },
            observed: { a: 3 },
            reason: 'different',
          }),
          result('added'),
        ],
        'd'.repeat(64),
      ),
      null,
      'all',
    );
    const data = await readHistory(root, null, 'all');
    expect(data.changes).toEqual([
      expect.objectContaining({ check_id: 'added', kind: 'added' }),
      expect.objectContaining({ check_id: 'removed', kind: 'removed' }),
      expect.objectContaining({ check_id: 'same', kind: 'expected_changed', status: 'drift' }),
      expect.objectContaining({ check_id: 'same', kind: 'observed_changed', status: 'drift' }),
      expect.objectContaining({ check_id: 'same', kind: 'reason_changed', status: 'drift' }),
      expect.objectContaining({ check_id: 'same', kind: 'status_changed', status: 'drift' }),
    ]);
    expect(data.records[0].expected_fingerprint).toBe('d'.repeat(64));
    expect(data.designChanged).toBe(true);
  });
  it('rejects malformed and symlink history files', async () => {
    const root = await fixture();
    const dir = join(root, '.local', 'infra-doctor', 'history');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'bad.json'), '{');
    await expect(readHistory(root, null, 'all')).rejects.toThrow();
    await (await import('node:fs/promises')).rm(join(dir, 'bad.json'));
    const target = join(root, 'target');
    await writeFile(target, report([result('x')]));
    await symlink(target, join(dir, 'linked.json'));
    await expect(readHistory(root, null, 'all')).rejects.toThrow();
  });
  it('rejects inconsistent counts, exit codes, duplicate IDs, and empty reports', async () => {
    const root = await fixture();
    const valid = JSON.parse(report([result('one')]));
    for (const bad of [
      { ...valid, counts: { ...valid.counts, blocked: 1 } },
      { ...valid, exit_code: 2 },
      { ...valid, results: [] },
      {
        ...valid,
        results: [result('dup'), result('dup')],
        counts: { pass: 2, drift: 0, blocked: 0, manual: 0, not_applicable: 0 },
      },
    ])
      await expect(saveHistory(root, JSON.stringify(bad), null, 'all')).rejects.toThrow();
  });
  it('sanitizes tampered stored reason and next step in text and JSON summaries', async () => {
    const root = await fixture();
    const path = await saveHistory(root, report([result('safe.check')]), null, 'all');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const evil = 'https://FAKE_USER:FAKE_PASS@example.test/private?token=FAKE_TOKEN';
    stored.results[0].reason = evil;
    stored.results[0].next_step = evil;
    stored.extra_secret = 'FAKE_EXTRA_SECRET';
    await writeFile(path, JSON.stringify(stored));
    const data = await readHistory(root, null, 'all');
    for (const format of ['text', 'json'] as const) {
      const summary = historySummary(data, format);
      for (const sentinel of [
        'FAKE_USER',
        'FAKE_PASS',
        'FAKE_TOKEN',
        'FAKE_EXTRA_SECRET',
        '/private',
      ])
        expect(summary).not.toContain(sentinel);
    }
  });
  it('ignores object key and nested array order when comparing', async () => {
    const root = await fixture();
    await saveHistory(
      root,
      report([
        result('same', {
          observed: { nested: { a: 1, b: 2 }, values: [{ a: 1, b: 2 }, { c: 3 }] },
        }),
      ]),
      null,
      'all',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveHistory(
      root,
      report([
        result('same', {
          observed: { values: [{ c: 3 }, { b: 2, a: 1 }], nested: { b: 2, a: 1 } },
        }),
      ]),
      null,
      'all',
    );
    expect((await readHistory(root, null, 'all')).changes).toEqual([]);
  });
  it('renders empty state without implying healthy status', () => {
    expect(
      historySummary({ records: [], changes: [], designChanged: false, empty: true }, 'text'),
    ).toContain('未確認');
  });
});
