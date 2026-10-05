/** #2864: audit names must be accepted by the real database, including billing. */
import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database';

import { JOB_MAX_AGE_MINUTES } from '../../ops/cron-heartbeat-policy.mjs';

const captureUnexpectedError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key || new URL(url).origin !== 'http://127.0.0.1:54321') {
      throw new Error('Cron heartbeat integration requires the isolated local Supabase');
    }
    return createClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  },
}));

import { writeCronHeartbeat } from '../../ops/cron-heartbeat';

function runOwnerSql(sql: string): string {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { encoding: 'utf8', input: sql, env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Cron heartbeat integration requires psql and the isolated local database');
  }
  return result.stdout.trim();
}

// This suite is local-only; the integration runner rejects a silently skipped file.
describe.skipIf(process.env.USE_LOCAL_DB !== 'true')(
  'cron heartbeat database contract (#2864)',
  () => {
    it('the live CHECK constraint includes every audited job', () => {
      const definition = runOwnerSql(`
      SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.cron_heartbeats'::regclass
        AND conname = 'cron_heartbeats_job_name_check' AND contype = 'c';
    `);
      expect(definition).not.toBe('');
      const allowedNames = Array.from(definition.matchAll(/'([^']+)'/g), (match) => match[1]);
      for (const job of Object.keys(JOB_MAX_AGE_MINUTES)) {
        expect(allowedNames, `${job} is audited but rejected by the database CHECK`).toContain(job);
      }
    });

    it('the real writer creates and completes a billing heartbeat through local PostgREST', async () => {
      // Preserve this singleton's prior evidence even when an assertion fails.
      const original = runOwnerSql(`
      SELECT COALESCE(json_agg(h), '[]'::json)::text FROM public.cron_heartbeats h
      WHERE job_name = 'billing-reconciliation';
    `);
      try {
        runOwnerSql(
          "DELETE FROM public.cron_heartbeats WHERE job_name = 'billing-reconciliation';",
        );
        captureUnexpectedError.mockClear();
        const startedAt = new Date().toISOString();
        await writeCronHeartbeat('billing-reconciliation', 'started', startedAt);
        const started = JSON.parse(
          runOwnerSql(`
        SELECT json_build_object('job_name', job_name, 'completed', last_completed_at)
        FROM public.cron_heartbeats WHERE job_name = 'billing-reconciliation';
      `),
        );
        expect(started).toEqual({ job_name: 'billing-reconciliation', completed: null });

        await writeCronHeartbeat('billing-reconciliation', 'completed', startedAt);
        const completed = JSON.parse(
          runOwnerSql(`
        SELECT json_build_object(
          'job_name', job_name, 'started', last_started_at,
          'completed', last_completed_at, 'summary', last_summary
        ) FROM public.cron_heartbeats WHERE job_name = 'billing-reconciliation';
      `),
        );
        expect(completed.job_name).toBe('billing-reconciliation');
        expect(Date.parse(completed.started)).toBe(Date.parse(startedAt));
        expect(Date.parse(completed.completed)).toBeGreaterThanOrEqual(Date.parse(startedAt));
        expect(completed.summary).toEqual({ succeeded: true, duration_ms: expect.any(Number) });
        expect(captureUnexpectedError).not.toHaveBeenCalled();
      } finally {
        const originalLiteral = original.replaceAll("'", "''");
        runOwnerSql(`
        BEGIN;
        DELETE FROM public.cron_heartbeats WHERE job_name = 'billing-reconciliation';
        INSERT INTO public.cron_heartbeats
        SELECT * FROM json_populate_recordset(NULL::public.cron_heartbeats, '${originalLiteral}'::json);
        COMMIT;
      `);
      }
    });
  },
);
