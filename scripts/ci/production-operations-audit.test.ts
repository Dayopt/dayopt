import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runReadOnlyQuery, scalarResult } from '../lib/production-db-readonly.mjs';
import {
  JOB_MAX_AGE_MINUTES,
  auditHeartbeats,
  evaluateHeartbeats,
} from './production-cron-heartbeat-audit.mjs';
import { auditSchema, compareMigrationVersions } from './production-schema-drift-audit.mjs';

const now = Date.parse('2026-09-14T00:00:00Z');
const fresh = () =>
  Object.keys(JOB_MAX_AGE_MINUTES).map((job_name) => ({
    job_name,
    last_completed_at: new Date(now).toISOString(),
  }));

describe('production cron heartbeat evidence', () => {
  it('requires every expected job and rejects missing completion', async () => {
    expect(evaluateHeartbeats(fresh(), now)).toEqual([]);
    await expect(auditHeartbeats(async () => fresh().slice(1), now)).rejects.toThrow('missing');
    expect(
      evaluateHeartbeats([{ ...fresh()[0], last_completed_at: null }, ...fresh().slice(1)], now),
    ).not.toEqual([]);
  });
  it.each(Object.entries(JOB_MAX_AGE_MINUTES))(
    'enforces the actual %s cadence',
    (name, minutes) => {
      const rows = fresh();
      const row = rows.find((row) => row.job_name === name)!;
      row.last_completed_at = new Date(now - minutes * 60_000).toISOString();
      expect(evaluateHeartbeats(rows, now)).toEqual([]);
      row.last_completed_at = new Date(now - minutes * 60_000 - 1).toISOString();
      expect(evaluateHeartbeats(rows, now)).toEqual([expect.stringContaining(name)]);
    },
  );
  it('does not turn API failure or future timestamps into healthy evidence', async () => {
    await expect(
      auditHeartbeats(async () => {
        throw new Error('offline');
      }, now),
    ).rejects.toThrow('offline');
    const rows = fresh();
    rows[0]!.last_completed_at = new Date(now + 60_001).toISOString();
    expect(evaluateHeartbeats(rows, now)).not.toEqual([]);
  });
});

describe('production schema and query boundary', () => {
  it('detects an unapplied version while allowing separately reported extra history', () => {
    expect(compareMigrationVersions(['20260914001000'], [{ version: '00000000000000' }])).toEqual({
      missing: ['20260914001000'],
      extra: ['00000000000000'],
    });
    expect(() => compareMigrationVersions([], [{ version: null }])).toThrow('Invalid');
  });
  it('enforces read-only requests and suppresses upstream error bodies', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('upstream-private-value', { status: 401 }));
    await expect(
      runReadOnlyQuery('SELECT 1', { token: 'fixture-token', fetchImpl }),
    ).rejects.toThrow('HTTP 401');
    const options = fetchImpl.mock.calls[0]![1];
    expect(JSON.parse(options.body)).toEqual({ query: 'SELECT 1', read_only: true });
    expect(options.redirect).toBe('error');
    fetchImpl.mockClear();
    await expect(runReadOnlyQuery('SELECT 1', { token: '', fetchImpl })).rejects.toThrow(
      'required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not accept empty or ambiguous scalar metadata', () => {
    expect(scalarResult([{ value: [] }])).toEqual([]);
    expect(() => scalarResult([])).toThrow('exactly one');
    expect(() => scalarResult([{ a: 1, b: 2 }])).toThrow('exactly one');
  });
  it('fails the executable audit when credentials are missing', () => {
    const result = spawnSync(process.execPath, ['scripts/ci/production-cron-heartbeat-audit.mjs'], {
      env: { ...process.env, SUPABASE_STORAGE_RLS_AUDIT_TOKEN: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Audit passed');
  });
  it('connects both failure results to the existing issue notification job', () => {
    const workflow = readFileSync('.github/workflows/production-config-audit.yml', 'utf8');
    expect(workflow).toContain('needs: [auth-config, storage-rls, cron-heartbeat, schema-drift]');
    expect(workflow).toContain("needs.cron-heartbeat.result == 'failure'");
    expect(workflow).toContain("needs.schema-drift.result == 'failure'");
    expect(workflow).toContain('HEARTBEAT_RESULT: ${{ needs.cron-heartbeat.result }}');
    expect(workflow).toContain('SCHEMA_RESULT: ${{ needs.schema-drift.result }}');
    expect(workflow).toContain('| Audit production cron heartbeats |');
    expect(workflow).toContain('| Audit production schema and ACL |');
  });
});

describe('operational failure delivery', () => {
  it.each(['', '9999'])(
    'executes the real notification shell with existing issue %s',
    (existing) => {
      const workflow = readFileSync('.github/workflows/production-config-audit.yml', 'utf8');
      const notification = workflow.split('  notify-supabase-audit-failure:')[1]!;
      const script = notification
        .split('        run: |\n')[1]!
        .split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n');
      const temp = mkdtempSync(join(tmpdir(), 'dayopt-notification-'));
      const calls = join(temp, 'calls');
      try {
        // Shadow gh inside the same shell: no network or real GitHub mutation is possible.
        const fakeGh =
          'gh() { printf "%s\\0" "$@" >> "$FIXTURE_CALLS"; if [ "$1 $2" = "issue list" ]; then printf "%s" "$FIXTURE_EXISTING"; fi; }\n';
        const result = spawnSync('bash', ['-c', fakeGh + script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_TOKEN: 'fixture',
            GITHUB_REPOSITORY: 'fixture/repo',
            RUN_URL: 'https://example.invalid/run/1',
            EVENT_NAME: 'schedule',
            AUTH_RESULT: 'skipped',
            STORAGE_RESULT: 'skipped',
            HEARTBEAT_RESULT: 'failure',
            SCHEMA_RESULT: 'failure',
            FIXTURE_CALLS: calls,
            FIXTURE_EXISTING: existing,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const args = readFileSync(calls, 'utf8').split('\0');
        expect(args).toContain(existing ? 'comment' : 'create');
        if (existing) expect(args).toContain(existing);
        const body = args[args.indexOf('--body') + 1]!;
        expect(body).toContain('| Audit production cron heartbeats | `failure` |');
        expect(body).toContain('| Audit production schema and ACL | `failure` |');
        expect(body).toContain('https://example.invalid/run/1');
        expect(body).toContain('**Cron heartbeat**');
        expect(body).toContain('**Schema/ACL**');
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
  it('fails when the reused snapshot detects drift and never generates a production baseline', async () => {
    const versions = readdirSync('supabase/migrations')
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .map((name) => ({ version: name.slice(0, 14) }));
    const execute = vi.fn().mockReturnValue({ status: 1 });
    await expect(auditSchema({ query: async () => versions, execute })).rejects.toThrow(
      'snapshot differs',
    );
    expect(execute).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'tsx', 'scripts/tasks/generate-rls-snapshot.ts', '--check'],
      expect.objectContaining({
        env: expect.objectContaining({ RLS_SNAPSHOT_TRANSPORT: 'management-api' }),
      }),
    );
    execute.mockClear();
    await expect(auditSchema({ query: async () => [], execute })).rejects.toThrow(
      'Unapplied migrations',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
