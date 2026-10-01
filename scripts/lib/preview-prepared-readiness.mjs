import { prepareFixtureAuthority, verifyPreviewAccessToken } from './preview-fixture-authority.mjs';

/** Only accept this snapshot after authenticated handoff from the trusted job.
 * This is its PRE-run provider observation, not a new provider query. */
export function preparedReadinessSnapshot(input, value, now = Date.now()) {
  const authority = prepareFixtureAuthority(input);
  const request = authority.intent.request;
  if (
    authority.operation !== 'provision' ||
    request.databaseMode !== 'ephemeral' ||
    value?.status !== 'ready' ||
    value.origin !== authority.origin ||
    Object.entries(request).some(([key, expected]) => value[key] !== expected) ||
    !Array.isArray(value.migrationVersions) ||
    !value.migrationVersions.length ||
    value.migrationVersions.length > 2000 ||
    !value.migrationVersions.every((v) => typeof v === 'string' && /^\d{14}$/.test(v)) ||
    new Set(value.migrationVersions).size !== value.migrationVersions.length ||
    !Number.isFinite(now)
  )
    throw new Error('Prepared Preview readiness is invalid');
  const started = Date.parse(value.startedAt);
  const observed = Date.parse(value.observedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(observed) ||
    started > observed ||
    observed > now ||
    now - started > 600_000
  )
    throw new Error('Prepared Preview readiness is stale');
  return {
    status: 'ready',
    ...request,
    origin: authority.origin,
    migrationVersions: [...value.migrationVersions].sort(),
    startedAt: new Date(started).toISOString(),
    observedAt: new Date(observed).toISOString(),
  };
}

/** Signature verification precedes using exp as an execution deadline. */
export async function preparedAccessDeadline({
  input,
  token,
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
}) {
  await verifyPreviewAccessToken({ input, token, fetchImpl, now });
  const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return exp * 1000;
}

export function remainingPreparedBudget(deadline, now = Date.now(), reserve = 30_000) {
  if (
    !Number.isSafeInteger(deadline) ||
    !Number.isSafeInteger(now) ||
    deadline - now > 600_000 ||
    deadline - now <= reserve
  )
    throw new Error('Prepared Preview access window exhausted');
  return Math.min(7 * 60_000, deadline - now - reserve);
}

async function runtimeJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { 'x-vercel-trusted-oidc-idp-token': token },
  });
  if (response.status !== 200 || response.redirected || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Consumer uses only its short-lived access token. Provider pre/post checks live
 * in separate trusted jobs. Never relabel this as a fresh provider observation. */
export async function observePreparedRuntime({
  input,
  snapshot,
  token,
  deadline,
  expectedMigrations,
  fetchImpl = fetch,
  now = Date.now,
}) {
  try {
    remainingPreparedBudget(deadline, now());
    const ready = preparedReadinessSnapshot(input, snapshot, now());
    if (JSON.stringify([...expectedMigrations].sort()) !== JSON.stringify(ready.migrationVersions))
      throw new Error();
    const version = await runtimeJson(`${ready.origin}/api/health/version`, token, fetchImpl);
    const health = await runtimeJson(`${ready.origin}/api/health`, token, fetchImpl);
    if (
      version?.preview?.deploymentId !== ready.deploymentId ||
      version.preview.sha !== ready.sha ||
      version.preview.supabaseProjectRef !== ready.supabaseProjectRef ||
      health?.status !== 'healthy' ||
      health.environment !== 'preview' ||
      health.checks?.database !== 'ok'
    )
      throw new Error();
    remainingPreparedBudget(deadline, now());
    return {
      ...ready,
      runtimeObservedAt: new Date(now()).toISOString(),
      providerPostConfirmed: false,
    };
  } catch {
    throw new Error('Prepared Preview runtime observation failed');
  }
}
