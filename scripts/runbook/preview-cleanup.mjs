import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SEED_USER = '00000000-0000-0000-0000-000000000001';
const STATUSES = new Set([
  'creating',
  'creation-unconfirmed',
  'created',
  'cleanup-failed',
  'deleted',
]);
const SYNTHETIC_EMAIL = /^(?:mobile-)?critical-path-[a-f0-9-]{36}@example\.com$/;

/** Recover only journaled synthetic users whose server-side ownership matches. */
export async function recoverPreviewUsers({
  evidenceDirectory,
  runId,
  supabaseProjectRef,
  serviceKey,
  fetchImpl = fetch,
  now = () => performance.now(),
}) {
  if (
    !UUID.test(runId ?? '') ||
    !/^[a-z]{20}$/.test(supabaseProjectRef ?? '') ||
    supabaseProjectRef === 'yvglwblxrnrenfifsnje' ||
    !serviceKey?.trim()
  )
    throw new Error('Preview cleanup requires a nonproduction run binding');
  if (!serviceKey.startsWith('sb_secret_')) {
    try {
      const parts = serviceKey.split('.');
      if (parts.length !== 3) throw new Error();
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (claims.role !== 'service_role' || claims.ref !== supabaseProjectRef) throw new Error();
    } catch {
      throw new Error('Preview cleanup credential binding is invalid');
    }
  }

  const directory = join(evidenceDirectory, 'users');
  if (!existsSync(directory)) return { status: 'clean', checked: 0, recovered: 0 };
  // Validate all records before making any request. Raw journal contents and
  // provider errors are never diagnostics or artifact fields.
  let records;
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw new Error();
    const names = readdirSync(directory).filter((name) => {
      // An interrupted atomic journal update can leave its private temporary
      // sibling. The preceding committed record is the recovery authority.
      return !/^[a-f0-9-]{36}\.json\.tmp$/.test(name);
    });
    if (names.length > 256) throw new Error();
    records = names.map((name) => {
      if (
        !name.endsWith('.json') ||
        !lstatSync(join(directory, name)).isFile() ||
        lstatSync(join(directory, name)).isSymbolicLink()
      )
        throw new Error();
      const row = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (
        !UUID.test(row.userId ?? '') ||
        row.userId === SEED_USER ||
        row.runId !== runId ||
        name !== `${row.userId}.json` ||
        !STATUSES.has(row.status)
      )
        throw new Error();
      return { userId: row.userId, path: join(directory, name) };
    });
  } catch {
    throw new Error('Preview cleanup journal is invalid');
  }

  const deadline = now() + 120_000;
  async function request(userId, method = 'GET') {
    const remaining = Math.ceil(deadline - now());
    if (remaining <= 0) throw new Error('Preview cleanup deadline exceeded');
    return fetchImpl(`https://${supabaseProjectRef}.supabase.co/auth/v1/admin/users/${userId}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
  }
  let recovered = 0;
  let failed = false;
  for (const record of records) {
    let status = 'cleanup-failed';
    try {
      const observed = await request(record.userId);
      if (observed.status === 404) status = 'deleted';
      else {
        if (!observed.ok) throw new Error();
        const user = await observed.json();
        if (
          user.id !== record.userId ||
          user.app_metadata?.e2e_run_id !== runId ||
          !SYNTHETIC_EMAIL.test(user.email ?? '')
        )
          throw new Error();
        const removed = await request(record.userId, 'DELETE');
        if (!removed.ok) throw new Error();
        if ((await request(record.userId)).status !== 404) throw new Error();
        recovered++;
        status = 'deleted';
      }
    } catch {
      // Ownership mismatch and network/provider failure remain explicit failures.
      failed = true;
    }
    const temporary = `${record.path}.tmp`;
    if (existsSync(temporary) && !lstatSync(temporary).isFile()) {
      throw new Error('Preview cleanup journal temporary file is invalid');
    }
    writeFileSync(
      temporary,
      JSON.stringify({
        runId,
        userId: record.userId,
        status,
        observedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, record.path);
  }
  return { status: failed ? 'failed' : 'clean', checked: records.length, recovered };
}
