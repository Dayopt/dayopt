import { createClient } from '@supabase/supabase-js';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ref = 'abcdefghijklmnopqrst';
const digest = 'a'.repeat(64);
const owner = randomUUID();
const otherOwner = randomUUID();
const runIds: string[] = [];
const signature = 'preview_fixture_lifecycle_v1(text,uuid,text,uuid,text,text,boolean)';
const execAsync = promisify(execFile);
const args = [DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];

function localOnly() {
  if (!RUN_LOCAL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname))
    throw new Error('Preview lifecycle tests require isolated CI database');
}
function sql(command: string) {
  localOnly();
  return execFileSync('psql', args, { input: command, encoding: 'utf8' }).trim();
}
function runId() {
  const id = randomUUID();
  runIds.push(id);
  return id;
}
function call(
  id: string,
  action: 'claim' | 'guard' | 'finish',
  operation: 'provision' | 'cleanup' | 'recover' = 'provision',
  selectedOwner = owner,
  success: boolean | null = null,
  selectedDigest = digest,
) {
  // Arguments are test-owned UUIDs, fixed literals and union values only.
  return `BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims = '{"role":"service_role"}';
    SELECT public.preview_fixture_lifecycle_v1('${ref}', '${id}', '${selectedDigest}',
      '${selectedOwner}', '${action}', '${operation}', ${success === null ? 'NULL' : success}); COMMIT;`;
}
function status(...parameters: Parameters<typeof call>) {
  return JSON.parse(sql(call(...parameters))).status;
}

describe.skipIf(!RUN_LOCAL)('durable Preview fixture lifecycle in isolated CI Postgres', () => {
  beforeAll(localOnly);
  afterEach(() => {
    if (runIds.length)
      sql(
        `DELETE FROM private.preview_fixture_lifecycle WHERE database_ref = '${ref}' AND run_id IN (${runIds
          .splice(0)
          .map((id) => `'${id}'::uuid`)
          .join(',')});`,
      );
  });
  it('serializes owners and rejects altered intent or stale owner', () => {
    const id = runId();
    expect(status(id, 'claim')).toBe('acquired');
    expect(status(id, 'claim')).toBe('acquired');
    expect(status(id, 'guard')).toBe('owned');
    expect(status(id, 'claim', 'provision', otherOwner)).toBe('busy');
    expect(status(id, 'claim', 'provision', otherOwner, null, 'b'.repeat(64))).toBe('denied');
    expect(status(id, 'finish', 'provision', otherOwner, true)).toBe('denied');
    expect(status(id, 'finish', 'provision', owner, true)).toBe('finished');
    expect(status(id, 'claim', 'provision', otherOwner)).toBe('acquired');
    expect(status(id, 'guard')).toBe('denied');
  });
  it('persists cleanup-first tombstone and allows cleanup retry only', () => {
    const id = runId();
    expect(status(id, 'claim', 'cleanup')).toBe('acquired');
    expect(status(id, 'finish', 'cleanup', owner, true)).toBe('finished');
    expect(status(id, 'claim')).toBe('closed');
    expect(status(id, 'claim', 'recover', otherOwner)).toBe('acquired');
    expect(status(id, 'guard', 'recover', otherOwner)).toBe('owned');
  });
  it('closes future provision immediately while the active owner can finish', () => {
    const id = runId();
    expect(status(id, 'claim')).toBe('acquired');
    expect(status(id, 'claim', 'cleanup', otherOwner)).toBe('busy');
    expect(status(id, 'guard')).toBe('owned');
    expect(status(id, 'finish', 'provision', owner, true)).toBe('finished');
    expect(status(id, 'claim')).toBe('closed');
    expect(status(id, 'claim', 'cleanup', otherOwner)).toBe('acquired');
  });
  it('never reissues an expired owner or clears UNKNOWN through late success', () => {
    const id = runId();
    expect(status(id, 'claim')).toBe('acquired');
    sql(
      `UPDATE private.preview_fixture_lifecycle SET deadline = pg_catalog.clock_timestamp() - INTERVAL '1 second' WHERE database_ref = '${ref}' AND run_id = '${id}';`,
    );
    expect(status(id, 'guard')).toBe('unknown');
    expect(status(id, 'finish', 'provision', owner, true)).toBe('unknown');
    expect(status(id, 'claim', 'recover', otherOwner)).toBe('unknown');
    expect(
      sql(
        `SELECT state || ':' || closed::text FROM private.preview_fixture_lifecycle WHERE database_ref = '${ref}' AND run_id = '${id}';`,
      ),
    ).toBe('UNKNOWN:true');
  });
  it('retains failure as UNKNOWN without an Auth foreign key', () => {
    const id = runId();
    expect(status(id, 'claim')).toBe('acquired');
    expect(status(id, 'finish', 'provision', owner, false)).toBe('unknown');
    expect(status(id, 'claim', 'cleanup', otherOwner)).toBe('unknown');
    expect(
      sql(
        "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid = 'private.preview_fixture_lifecycle'::regclass AND contype = 'f';",
      ),
    ).toBe('0');
  });
  it('quarantines the DB across run IDs after an uncertain operation', () => {
    const failedRun = runId();
    const activeRun = runId();
    const newRun = runId();
    expect(status(failedRun, 'claim')).toBe('acquired');
    expect(status(activeRun, 'claim')).toBe('acquired');
    expect(status(failedRun, 'finish', 'provision', owner, false)).toBe('unknown');
    expect(status(newRun, 'claim')).toBe('unknown');
    expect(status(activeRun, 'guard')).toBe('unknown');
    expect(status(activeRun, 'finish', 'provision', owner, true)).toBe('unknown');
    expect(status(newRun, 'claim', 'cleanup')).toBe('unknown');
    expect(status(newRun, 'claim', 'recover')).toBe('unknown');
    expect(
      sql(`SELECT count(*) FROM private.preview_fixture_lifecycle
      WHERE database_ref = '${ref}' AND run_id = '${newRun}';`),
    ).toBe('0');
  });
  it('discovers another run expired before granting a new run ownership', () => {
    const expiredRun = runId();
    expect(status(expiredRun, 'claim')).toBe('acquired');
    sql(`UPDATE private.preview_fixture_lifecycle
      SET deadline = pg_catalog.clock_timestamp() - INTERVAL '1 second'
      WHERE database_ref = '${ref}' AND run_id = '${expiredRun}';`);
    expect(status(runId(), 'claim')).toBe('unknown');
    expect(
      sql(`SELECT state || ':' || closed::text FROM private.preview_fixture_lifecycle
      WHERE database_ref = '${ref}' AND run_id = '${expiredRun}';`),
    ).toBe('UNKNOWN:true');
  });
  it('keeps healthy runs reusable after another run is cleanly recovered', () => {
    const cleanedRun = runId();
    expect(status(cleanedRun, 'claim', 'cleanup')).toBe('acquired');
    expect(status(cleanedRun, 'finish', 'cleanup', owner, true)).toBe('finished');
    expect(status(runId(), 'claim')).toBe('acquired');
  });
  it('allows exactly one simultaneous claim across independent SQL connections', async () => {
    const id = runId();
    localOnly();
    const results = await Promise.all(
      [owner, otherOwner].map(async (selectedOwner) => {
        const result = await execAsync('psql', [
          ...args,
          '-c',
          call(id, 'claim', 'provision', selectedOwner),
        ]);
        return JSON.parse(result.stdout.trim()).status;
      }),
    );
    expect(results.sort()).toEqual(['acquired', 'busy']);
  });
  it('runs the trusted SDK bridge against isolated PostgREST and durable SQL state', async () => {
    localOnly();
    const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SECRET_KEY;
    if (
      !apiUrl ||
      !serviceKey ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(apiUrl).hostname)
    )
      throw new Error('Preview lifecycle SDK test requires isolated CI API');
    const moduleUrl = new URL(
      '../../../../../../scripts/lib/preview-fixture-lifecycle.mjs',
      import.meta.url,
    );
    const { createSupabaseFixtureLifecycle } = await import(moduleUrl.href);
    const client = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const id = runId();
    const execute = createSupabaseFixtureLifecycle({ client });
    const binding = { key: ref + ':' + id, intentDigest: digest, operation: 'provision' };
    expect(
      await execute(
        binding,
        async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
          await beforeMutation();
          expect(
            sql(
              `SELECT state FROM private.preview_fixture_lifecycle WHERE database_ref = '${ref}' AND run_id = '${id}';`,
            ),
          ).toBe('ACTIVE');
          return 'prepared';
        },
      ),
    ).toBe('prepared');
    expect(
      sql(
        `SELECT state FROM private.preview_fixture_lifecycle WHERE database_ref = '${ref}' AND run_id = '${id}';`,
      ),
    ).toBe('IDLE');
    await execute(
      { ...binding, operation: 'cleanup' },
      async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
        await beforeMutation();
      },
    );
    expect(
      sql(
        `SELECT state || ':' || closed::text FROM private.preview_fixture_lifecycle WHERE database_ref = '${ref}' AND run_id = '${id}';`,
      ),
    ).toBe('CLEANED:true');
    await expect(execute(binding, async () => undefined)).rejects.toThrow(
      /^Preview fixture lifecycle failed$/,
    );
  });
  it('exposes only the service RPC and rejects user roles and protected database refs', () => {
    expect(
      sql(`SELECT has_table_privilege('service_role', 'private.preview_fixture_lifecycle', 'SELECT'),
      has_table_privilege('service_role', 'private.preview_fixture_lifecycle', 'UPDATE'),
      has_function_privilege('service_role', 'public.${signature}', 'EXECUTE'),
      has_function_privilege('anon', 'public.${signature}', 'EXECUTE'),
      has_function_privilege('authenticated', 'public.${signature}', 'EXECUTE');`),
    ).toBe('f|f|t|f|f');
    const id = runId();
    expect(() =>
      sql(call(id, 'claim').replace('SET LOCAL ROLE service_role', 'SET LOCAL ROLE anon')),
    ).toThrow();
    for (const protectedRef of ['yvglwblxrnrenfifsnje', 'tilwaprottpyhlfoggbb'])
      expect(() => sql(call(id, 'claim').replace(ref, protectedRef))).toThrow();
  });
});
