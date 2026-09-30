import { createHash, createPublicKey, verify } from 'node:crypto';

import { validateCloudIntent } from '../ci/preview-cloud-intent.mjs';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = `${ISSUER}/.well-known/jwks`;
const ENVIRONMENT = 'Preview – product';
const WORKFLOW = 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration';
export const PREVIEW_ACCESS_AUDIENCE = 'urn:dayopt:preview-access:v1';
const SUBJECT = `repo:Dayopt/dayopt:environment:${ENVIRONMENT}`;
const PROJECT = 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa';

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/** Canonical, public authority binding. This is not a credential or readiness proof. */
export function prepareFixtureAuthority(input) {
  if (
    !exactKeys(input, ['intent', 'execution', 'operation', 'origin']) ||
    !['provision', 'cleanup', 'recover'].includes(input.operation) ||
    !/^https:\/\/product-[a-z0-9]+-dayopt\.vercel\.app$/.test(input.origin ?? '') ||
    !exactKeys(input.execution, ['runId', 'attempt', 'workflowSha']) ||
    !Number.isSafeInteger(input.execution.runId) ||
    input.execution.runId < 1 ||
    !Number.isSafeInteger(input.execution.attempt) ||
    input.execution.attempt < 1 ||
    !/^[a-f0-9]{40}$/.test(input.execution.workflowSha ?? '')
  )
    throw new Error('Preview fixture authority is invalid');
  const intent = validateCloudIntent(input.intent);
  // Shared mode already has its existing trusted path. This broker is for an
  // independently selected ephemeral DB; neither shared nor Production is a fallback.
  if (intent.request.databaseMode !== 'ephemeral')
    throw new Error('Preview fixture authority is invalid');
  const sameAttempt =
    input.execution.runId === intent.sourceRunId &&
    input.execution.attempt === intent.sourceAttempt;
  if (
    input.operation === 'recover'
      ? sameAttempt ||
        (input.execution.runId === intent.sourceRunId &&
          input.execution.attempt < intent.sourceAttempt)
      : !sameAttempt || input.execution.workflowSha !== intent.workflowSha
  )
    throw new Error('Preview fixture execution binding differs');
  const authority = {
    operation: input.operation,
    origin: input.origin,
    intent,
    execution: {
      runId: input.execution.runId,
      attempt: input.execution.attempt,
      workflowSha: input.execution.workflowSha,
    },
  };
  const serialized = JSON.stringify(authority);
  if (Buffer.byteLength(serialized) > 16_384)
    throw new Error('Preview fixture authority is invalid');
  return {
    ...authority,
    audience: `urn:dayopt:preview-fixture:v1:${createHash('sha256').update(serialized).digest('hex')}`,
  };
}

/** Must run before loading any admin key or performing any fixture mutation. */
export function assertFixtureBrokerTarget(input, env = process.env) {
  const authority = prepareFixtureAuthority(input);
  const request = authority.intent.request;
  if (
    env.VERCEL_ENV !== 'preview' ||
    env.VERCEL_PROJECT_ID !== PROJECT ||
    env.VERCEL_URL !== new URL(authority.origin).hostname ||
    env.VERCEL_DEPLOYMENT_ID !== request.deploymentId ||
    env.VERCEL_GIT_REPO_OWNER !== 'Dayopt' ||
    env.VERCEL_GIT_REPO_SLUG !== 'dayopt' ||
    env.VERCEL_GIT_COMMIT_SHA !== request.sha ||
    env.VERCEL_GIT_COMMIT_REF !== request.branchName ||
    env.NEXT_PUBLIC_SUPABASE_URL !== `https://${request.supabaseProjectRef}.supabase.co`
  )
    throw new Error('Preview fixture broker target differs');
  return authority;
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.toString('base64url') !== part) throw new Error();
  const value = JSON.parse(decoded.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value;
}

function assertClaims(claims, authority, now) {
  const execution = authority.execution;
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    claims.iss !== ISSUER ||
    claims.aud !== authority.audience ||
    claims.sub !== SUBJECT ||
    claims.repository !== 'Dayopt/dayopt' ||
    claims.repository_id !== '1006944000' ||
    claims.repository_owner !== 'Dayopt' ||
    claims.repository_owner_id !== '254866353' ||
    claims.environment !== ENVIRONMENT ||
    claims.ref !== 'refs/heads/integration' ||
    claims.ref_type !== 'branch' ||
    claims.workflow_ref !== WORKFLOW ||
    claims.event_name !== 'workflow_dispatch' ||
    claims.runner_environment !== 'github-hosted' ||
    claims.sha !== execution.workflowSha ||
    (claims.workflow_sha !== undefined && claims.workflow_sha !== execution.workflowSha) ||
    claims.run_id !== String(execution.runId) ||
    claims.run_attempt !== String(execution.attempt) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.nbf) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat < now - 600 ||
    claims.iat > now + 30 ||
    claims.nbf < 0 ||
    claims.nbf > now + 30 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 600
  )
    throw new Error();
}

async function readBoundedJson(response) {
  if (!response.ok || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readKeys(fetchImpl) {
  const body = await readBoundedJson(
    await fetchImpl(JWKS, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (!Array.isArray(body?.keys) || body.keys.length < 1 || body.keys.length > 32)
    throw new Error();
  return body.keys;
}

/**
 * Trusted-job-only capability. Do not import/call from candidate install or test
 * jobs, or give those jobs id-token:write / the request bearer environment.
 * The caller keeps the result in memory; never log or upload it.
 */
async function requestJobToken(
  { input, env = process.env, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) },
  access = false,
) {
  try {
    const authority = prepareFixtureAuthority(input);
    if (access) authority.audience = PREVIEW_ACCESS_AUDIENCE;
    if (
      env.GITHUB_REPOSITORY !== 'Dayopt/dayopt' ||
      env.GITHUB_REF !== 'refs/heads/integration' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_WORKFLOW_REF !== WORKFLOW ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_SHA !== authority.execution.workflowSha ||
      env.GITHUB_RUN_ID !== String(authority.execution.runId) ||
      env.GITHUB_RUN_ATTEMPT !== String(authority.execution.attempt) ||
      typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string' ||
      !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.trim() ||
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 16_384
    )
      throw new Error();
    const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (
      endpoint.protocol !== 'https:' ||
      !endpoint.hostname.endsWith('.actions.githubusercontent.com') ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw new Error();
    endpoint.searchParams.set('audience', authority.audience);
    const body = await readBoundedJson(
      await fetchImpl(endpoint.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      }),
    );
    // Check provider signature and the complete selected job/target binding
    // before handing the token to the broker transport.
    await verifyJobToken({ input, token: body?.value, fetchImpl, now }, access);
    return body.value;
  } catch {
    throw new Error('Preview fixture job token could not be requested');
  }
}

/**
 * Only a trusted, isolated workflow job may mint this audience-bound token.
 * For recover, that job must first verify the original failed attempt/artifact
 * using preview-cloud-recovery-trust; this function is not artifact verification.
 * It never returns token claims, credentials, provider bodies, or raw errors.
 */
async function verifyJobToken(
  { input, token, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) },
  access = false,
) {
  try {
    const authority = prepareFixtureAuthority(input);
    if (access) authority.audience = PREVIEW_ACCESS_AUDIENCE;
    if (typeof token !== 'string' || token.length > 16_384) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error();
    const header = decodePart(parts[0]);
    if (
      header.alg !== 'RS256' ||
      header.typ !== 'JWT' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(header.kid ?? '') ||
      Object.keys(header).some((key) => !['alg', 'typ', 'kid', 'x5t'].includes(key))
    )
      throw new Error();
    const claims = decodePart(parts[1]);
    assertClaims(claims, authority, now());
    const keys = (await readKeys(fetchImpl)).filter((key) => key?.kid === header.kid);
    if (keys.length !== 1) throw new Error();
    const key = keys[0];
    if (
      key.kty !== 'RSA' ||
      key.alg !== 'RS256' ||
      key.use !== 'sig' ||
      typeof key.n !== 'string' ||
      key.n.length > 1024 ||
      typeof key.e !== 'string' ||
      key.e.length > 16
    )
      throw new Error();
    const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' });
    const bits = publicKey.asymmetricKeyDetails?.modulusLength;
    const signature = Buffer.from(parts[2], 'base64url');
    if (
      publicKey.asymmetricKeyType !== 'rsa' ||
      !bits ||
      bits < 2048 ||
      bits > 4096 ||
      signature.length !== bits / 8 ||
      signature.toString('base64url') !== parts[2] ||
      !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature)
    )
      throw new Error();
    // A token valid before the JWKS request may expire during that request.
    assertClaims(claims, authority, now());
    return authority;
  } catch {
    throw new Error('Preview fixture job authentication failed');
  }
}

// The fixed access audience cannot authenticate a broker mutation. These wrappers
// expose no caller-controlled audience/claim overrides.
export const requestFixtureJobToken = (options) => requestJobToken(options);
export const verifyFixtureJobToken = (options) => verifyJobToken(options);
export const requestPreviewAccessToken = (options) => requestJobToken(options, true);
export const verifyPreviewAccessToken = (options) => verifyJobToken(options, true);
