import { createHash, createHmac } from 'node:crypto';

import { assertFixtureBrokerTarget, verifyFixtureJobToken } from './preview-fixture-authority.mjs';
import { assertCloudFixtureKey } from './preview-fixture-key.mjs';

const TABLES = ['records', 'plans', 'activities', 'categories', 'user_settings', 'profiles'];
const SLOT_PREFIX = { desktop: 'critical-path', mobile: 'mobile-critical-path' };

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rowId(runId, userId, kind) {
  const bytes = Buffer.from(digest(['preview-fixture-v1', runId, userId, kind]), 'hex').subarray(
    0,
    16,
  );
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identity(intent, slot, key) {
  const userId = intent.userIds[slot];
  // The same authenticated intent can recover an interrupted provision without
  // resetting a password or creating another identity. Rotation fails closed for
  // existing users; cleanup does not depend on the old credential generation.
  const generation = createHmac('sha256', key)
    .update(JSON.stringify(['preview-fixture-v1', intent.runId, userId]))
    .digest('base64url');
  return {
    userId,
    email: `${SLOT_PREFIX[slot]}-${userId}@example.com`,
    password: `E2e!${generation}`,
    activityName: `Journey ${userId.slice(0, 8)}`,
    categoryName: `Cat ${userId.slice(0, 8)}`,
    categoryId: rowId(intent.runId, userId, 'category'),
    activityId: rowId(intent.runId, userId, 'activity'),
    generation: digest(generation),
  };
}

async function readUser(admin, userId) {
  const result = await admin.auth.admin.getUserById(userId);
  if (result.error?.status === 404) return null;
  if (result.error || result.data?.user?.id !== userId) throw new Error();
  return result.data.user;
}

function assertOwned(user, selected, intent) {
  if (
    user.id !== selected.userId ||
    user.email !== selected.email ||
    user.app_metadata?.e2e_run_id !== intent.runId ||
    user.app_metadata?.e2e_fixture_intent !== digest(intent)
  )
    throw new Error();
}

async function ensureRow(admin, table, row) {
  // Ignore conflicts rather than overwrite an existing primary key. A second
  // ownership read also rejects a foreign row inserted during a concurrent call.
  const before = await admin.from(table).select('id,user_id').eq('id', row.id).maybeSingle();
  if (before.error || (before.data && before.data.user_id !== row.user_id)) throw new Error();
  const inserted = await admin
    .from(table)
    .upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (inserted.error) throw new Error();
  const after = await admin.from(table).select('id,user_id').eq('id', row.id).single();
  if (after.error || after.data?.id !== row.id || after.data?.user_id !== row.user_id)
    throw new Error();
}

async function provisionUser(admin, selected, intent, observed) {
  let user = observed;
  if (!user) {
    // A lost/error response may have committed, but readback cannot resolve all
    // outstanding provider work. Propagate failure to the durable lifecycle gate;
    // do not return credentials or let a successful read clear an UNKNOWN state.
    const created = await admin.auth.admin.createUser({
      id: selected.userId,
      email: selected.email,
      password: selected.password,
      email_confirm: true,
      app_metadata: {
        e2e_run_id: intent.runId,
        e2e_fixture_intent: digest(intent),
        e2e_fixture_generation: selected.generation,
        e2e_fixture_ready: false,
      },
      user_metadata: { full_name: 'Cloud Preview synthetic user' },
    });
    if (created.error || created.data?.user?.id !== selected.userId) throw new Error();
    user = await readUser(admin, selected.userId);
  }
  if (!user) throw new Error();
  assertOwned(user, selected, intent);
  if (user.app_metadata.e2e_fixture_generation !== selected.generation) throw new Error();
  if (user.app_metadata.e2e_fixture_ready === true) return;

  const profile = await admin.from('profiles').upsert({
    id: selected.userId,
    email: selected.email,
  });
  const settings = await admin.from('user_settings').upsert({
    user_id: selected.userId,
    timezone: 'Asia/Tokyo',
    preferred_locale: 'ja',
    default_view: 'day',
    default_duration: 60,
    time_format: '24h',
    week_starts_on: 1,
  });
  if (profile.error || settings.error) throw new Error();
  await ensureRow(admin, 'categories', {
    id: selected.categoryId,
    user_id: selected.userId,
    name: selected.categoryName,
    color: 'blue',
    icon: 'circle',
  });
  await ensureRow(admin, 'activities', {
    id: selected.activityId,
    user_id: selected.userId,
    category_id: selected.categoryId,
    name: selected.activityName,
  });
  const ready = await admin.auth.admin.updateUserById(selected.userId, {
    app_metadata: { ...user.app_metadata, e2e_fixture_ready: true },
  });
  if (ready.error) throw new Error();
  const finalUser = await readUser(admin, selected.userId);
  if (!finalUser) throw new Error();
  assertOwned(finalUser, selected, intent);
  if (finalUser.app_metadata.e2e_fixture_ready !== true) throw new Error();
}

async function cleanupUser(admin, selected, intent) {
  const observed = await readUser(admin, selected.userId);
  if (observed) {
    assertOwned(observed, selected, intent);
    const removed = await admin.auth.admin.deleteUser(selected.userId, false);
    if (removed.error || (await readUser(admin, selected.userId)) !== null) throw new Error();
  }
  // Deletion success alone is not evidence that fixture data cascaded away.
  for (const table of TABLES) {
    const remaining = await admin
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(table === 'profiles' ? 'id' : 'user_id', selected.userId);
    if (remaining.error || remaining.count !== 0) throw new Error();
  }
}

/**
 * Server-only executor for a reviewed Preview build. createClient is the
 * installed Supabase SDK factory, supplied by the server adapter. No SQL, table,
 * user selector, credential, or callback can be supplied by the HTTP request.
 * Recovery callers must verify the source failed attempt/artifact first.
 * withLifecycle is mandatory: its trusted adapter must durably serialize by
 * database + run ID across instances, bind the intent digest, and retain a
 * terminal tombstone from cleanup/recover START (including failed cleanup).
 * The callback scope must provide beforeMutation(), which verifies its current
 * unexpired durable owner before every SDK write. A rejected check poisons this
 * invocation; it cannot revoke a request already sent to the provider.
 * No in-process default is safe for a server request surviving a worker crash.
 * Until that adapter exists, callers must not expose this executor as an API.
 * Returned provisioning credentials are private and must never be logged.
 */
export async function executeFixtureBroker({
  input,
  token,
  createClient,
  withLifecycle,
  env = process.env,
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
  elapsed = () => performance.now(),
}) {
  try {
    const target = assertFixtureBrokerTarget(input, env);
    const bound = {
      operation: target.operation,
      origin: target.origin,
      intent: target.intent,
      execution: target.execution,
    };
    await verifyFixtureJobToken({ input: bound, token, fetchImpl, now });
    if (typeof withLifecycle !== 'function') throw new Error();
    return await withLifecycle(
      {
        key: `${bound.intent.request.supabaseProjectRef}:${bound.intent.runId}`,
        intentDigest: digest(bound.intent),
        operation: bound.operation,
      },
      async (scope) => {
        if (typeof scope?.beforeMutation !== 'function') throw new Error();
        // A request may wait for an earlier operation. Do not acquire admin
        // authority using a token that expired while waiting for the lifecycle gate.
        await verifyFixtureJobToken({ input: bound, token, fetchImpl, now });
        // Key access is deliberately after both target and authenticated job checks.
        const key = env.SUPABASE_SECRET_KEY;
        await assertCloudFixtureKey({ request: bound.intent.request, serviceKey: key, fetchImpl });
        const origin = `https://${bound.intent.request.supabaseProjectRef}.supabase.co`;
        const deadline = elapsed() + 120_000;
        let ownershipLost = false;
        const admin = createClient(origin, key, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: {
            fetch: async (url, init = {}) => {
              const destination = new URL(
                typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
              );
              if (destination.origin !== origin || elapsed() >= deadline) throw new Error();
              const method = String(
                init.method ?? (url instanceof Request ? url.method : 'GET'),
              ).toUpperCase();
              if (!['GET', 'HEAD'].includes(method)) {
                if (ownershipLost) throw new Error();
                try {
                  await scope.beforeMutation();
                } catch {
                  ownershipLost = true;
                  throw new Error();
                }
                // A parallel cleanup check may fail while this check is pending.
                if (ownershipLost) throw new Error();
              }
              const remaining = Math.ceil(deadline - elapsed());
              if (remaining <= 0) throw new Error();
              return fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.any([
                  AbortSignal.timeout(Math.min(15_000, remaining)),
                  ...(init.signal ? [init.signal] : []),
                ]),
              });
            },
          },
        });
        const slots = ['desktop', 'mobile'];
        const selected = slots.map((slot) => identity(bound.intent, slot, key));
        const observed = [];
        // Validate the entire requested set before the first write. A foreign user
        // in either slot prevents all mutations, including partial cleanup.
        for (const user of selected) {
          const existing = await readUser(admin, user.userId);
          if (existing) assertOwned(existing, user, bound.intent);
          observed.push(existing);
        }
        if (bound.operation === 'provision') {
          for (let i = 0; i < selected.length; i++) {
            if (
              observed[i] &&
              observed[i].app_metadata.e2e_fixture_generation !== selected[i].generation
            )
              throw new Error();
          }
          for (let i = 0; i < selected.length; i++)
            await provisionUser(admin, selected[i], bound.intent, observed[i]);
          return {
            schemaVersion: 1,
            runId: bound.intent.runId,
            operation: bound.operation,
            users: Object.fromEntries(
              slots.map((slot, i) => {
                const { userId, email, password, activityName, categoryName } = selected[i];
                return [slot, { userId, email, password, activityName, categoryName }];
              }),
            ),
          };
        }
        // Attempt both owned users even when one provider deletion fails. The public
        // intent remains sufficient for an independent retry; no local journal needed.
        const cleanup = await Promise.allSettled(
          selected.map((user) => cleanupUser(admin, user, bound.intent)),
        );
        if (cleanup.some((result) => result.status === 'rejected')) throw new Error();
        return {
          schemaVersion: 1,
          runId: bound.intent.runId,
          operation: bound.operation,
          status: 'passed',
          absentUserIds: selected.map((user) => user.userId),
        };
      },
    );
  } catch {
    throw new Error('Preview fixture operation failed');
  }
}
