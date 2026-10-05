import { isDirectExecution } from '../lib/is-direct-execution.mjs';

export const PRODUCTION_PROJECT_REF = 'yvglwblxrnrenfifsnje';
export const INTEGRATION_PROJECT_REF = 'tilwaprottpyhlfoggbb';
export const INTEGRATION_BRANCH_ID = '4c2ed092-cba3-4f37-98e1-78f61cdf52ed';

const PROJECT_REF = /^[a-z]{20}$/;
const BRANCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRANCH_API = `https://api.supabase.com/v1/projects/${PRODUCTION_PROJECT_REF}/branches`;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const REPOSITORY = 'Dayopt/dayopt';

class ProvisionError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new ProvisionError(`Nonproduction login: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(url, token, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}` },
    });
    requireCondition(response.ok, 'Supabase metadata request failed');
    return await response.json();
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    throw new ProvisionError('Nonproduction login: Supabase metadata request failed');
  }
}

function validateBranch(branch, target) {
  requireCondition(
    isRecord(branch) &&
      PROJECT_REF.test(branch.project_ref ?? '') &&
      BRANCH_ID.test(branch.id ?? '') &&
      branch.parent_project_ref === PRODUCTION_PROJECT_REF &&
      branch.project_ref !== PRODUCTION_PROJECT_REF &&
      branch.is_default === false &&
      branch.with_data === false,
    'branch is not an isolated nonproduction child',
  );
  requireCondition(
    branch.status === 'FUNCTIONS_DEPLOYED' && branch.preview_project_status === 'ACTIVE_HEALTHY',
    'branch is not ready',
  );
  if (target.kind === 'integration') {
    requireCondition(
      branch.project_ref === INTEGRATION_PROJECT_REF &&
        branch.id === INTEGRATION_BRANCH_ID &&
        branch.git_branch === 'integration' &&
        branch.persistent === true,
      'Integration branch identity differs',
    );
  } else if (target.kind === 'preview') {
    requireCondition(
      branch.project_ref !== INTEGRATION_PROJECT_REF &&
        branch.id !== INTEGRATION_BRANCH_ID &&
        branch.git_branch === target.branchName &&
        branch.pr_number === target.prNumber &&
        branch.persistent === false,
      'Preview branch identity differs',
    );
  }
}

async function wait(milliseconds, sleepImpl) {
  await sleepImpl(milliseconds);
}

async function findReadyBranch({ target, supabaseToken, fetchImpl, sleepImpl, now }) {
  const timeoutAt = now() + 12 * 60_000;
  let lastReason = 'branch is not ready';
  while (now() < timeoutAt) {
    const branches = await readJson(BRANCH_API, supabaseToken, fetchImpl);
    requireCondition(Array.isArray(branches), 'branch inventory is invalid');
    const previewMatches =
      target.kind === 'preview'
        ? branches.filter(
            (branch) =>
              branch.pr_number === target.prNumber && branch.git_branch === target.branchName,
          )
        : [];
    requireCondition(previewMatches.length <= 1, 'branch identity is ambiguous');
    const matches =
      target.kind === 'integration'
        ? branches.filter((branch) => branch.id === INTEGRATION_BRANCH_ID)
        : previewMatches;
    requireCondition(matches.length <= 1, 'branch identity is ambiguous');
    if (matches.length === 1) {
      try {
        validateBranch(matches[0], target);
        return matches[0];
      } catch (error) {
        if (!(error instanceof ProvisionError) || !error.message.endsWith('branch is not ready'))
          throw error;
        lastReason = error.message;
      }
    }
    await wait(5_000, sleepImpl);
  }
  throw new ProvisionError(`Nonproduction login: ${lastReason}`);
}

function getApiKey(keys, type) {
  requireCondition(Array.isArray(keys), 'branch API keys are invalid');
  const active = keys.filter(
    (key) =>
      isRecord(key) &&
      (key.disabled === undefined || key.disabled === false) &&
      typeof key.api_key === 'string' &&
      key.api_key.length > 0,
  );
  const modern = active.filter(
    (key) => key.type === type || (key.type === undefined && key.name === type),
  );
  const legacyName = type === 'secret' ? 'service_role' : 'anon';
  const matches = modern.length > 0 ? modern : active.filter((key) => key.name === legacyName);
  requireCondition(matches.length === 1, `branch ${type} API key is unavailable or ambiguous`);
  return matches[0].api_key;
}

async function apiJson(url, { method = 'GET', key, body, fetchImpl }) {
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    throw new ProvisionError('Nonproduction login: branch Auth API request failed');
  }
}

function apiOrigin(projectRef) {
  requireCondition(
    PROJECT_REF.test(projectRef) && projectRef !== PRODUCTION_PROJECT_REF,
    'invalid Preview origin',
  );
  return `https://${projectRef}.supabase.co`;
}

async function revalidatePreviewTarget({ target, githubToken, fetchImpl }) {
  if (target.kind === 'integration') return;
  requireCondition(
    Number.isSafeInteger(target.prNumber) &&
      target.prNumber > 0 &&
      /^[a-f0-9]{40}$/.test(target.sha ?? '') &&
      ['main', 'integration'].includes(target.baseBranch) &&
      typeof githubToken === 'string' &&
      githubToken.trim(),
    'live PR identity is unavailable',
  );
  try {
    const response = await fetchImpl(
      `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}/pulls/${target.prNumber}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    requireCondition(response.ok, 'live PR revalidation failed');
    const pr = await response.json();
    requireCondition(
      pr?.number === target.prNumber &&
        pr.state === 'open' &&
        pr.draft === false &&
        pr.head?.sha === target.sha &&
        pr.head?.ref === target.branchName &&
        pr.head?.repo?.full_name === REPOSITORY &&
        pr.head?.repo?.fork === false &&
        pr.base?.ref === target.baseBranch &&
        pr.base?.repo?.full_name === REPOSITORY,
      'PR changed while the Preview branch was starting',
    );
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    throw new ProvisionError('Nonproduction login: live PR revalidation failed');
  }
}

function isDuplicateEmail(result) {
  if (result.status !== 400 && result.status !== 422) return false;
  const code =
    typeof result.data?.error_code === 'string'
      ? result.data.error_code
      : typeof result.data?.code === 'string'
        ? result.data.code
        : undefined;
  return code === 'email_exists' || code === 'user_already_exists';
}

async function verifyPasswordAndCloseLocalSession({
  origin,
  publishableKey,
  email,
  password,
  fetchImpl,
}) {
  const signIn = await apiJson(`${origin}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    key: publishableKey,
    body: { email, password },
    fetchImpl,
  });
  const accessToken = signIn.data?.access_token;
  requireCondition(
    signIn.ok && typeof accessToken === 'string' && accessToken.length > 0,
    'credentials did not authenticate on the target branch',
  );
  const mfaRequired = (signIn.data?.user?.factors ?? []).some(
    (factor) => factor?.status === 'verified',
  );
  const signOut = await apiJson(`${origin}/auth/v1/logout?scope=local`, {
    method: 'POST',
    key: publishableKey,
    fetchImpl: (url, options) =>
      fetchImpl(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
      }),
  });
  requireCondition(signOut.ok, 'verification session could not be closed locally');
  requireCondition(!mfaRequired, 'MFA enrollment requires interactive verification');
}

/**
 * Prepare the same nonproduction login on the explicitly selected Supabase branch.
 * Credentials and API keys remain in memory; the result contains identifiers only.
 */
export async function provisionNonproductionLogin({
  target,
  email,
  password,
  supabaseToken,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  githubToken = '',
}) {
  requireCondition(
    target &&
      (target.kind === 'integration' ||
        (target.kind === 'preview' &&
          Number.isSafeInteger(target.prNumber) &&
          target.prNumber > 0 &&
          typeof target.branchName === 'string' &&
          target.branchName.length > 0 &&
          /^[a-f0-9]{40}$/.test(target.sha ?? '') &&
          ['main', 'integration'].includes(target.baseBranch))),
    'target identity is invalid',
  );
  requireCondition(typeof email === 'string' && EMAIL.test(email), 'login email is invalid');
  requireCondition(
    typeof password === 'string' && password.length >= 8,
    'login password is invalid',
  );
  requireCondition(
    typeof supabaseToken === 'string' && supabaseToken.trim(),
    'Management API token is missing',
  );

  const branch = await findReadyBranch({ target, supabaseToken, fetchImpl, sleepImpl, now });
  const keys = await readJson(
    `https://api.supabase.com/v1/projects/${branch.project_ref}/api-keys?reveal=true`,
    supabaseToken,
    fetchImpl,
  );
  const secretKey = getApiKey(keys, 'secret');
  const publishableKey = getApiKey(keys, 'publishable');
  const origin = apiOrigin(branch.project_ref);
  await revalidatePreviewTarget({ target, githubToken, fetchImpl });
  const created = await apiJson(`${origin}/auth/v1/admin/users`, {
    method: 'POST',
    key: secretKey,
    body: { email, password, email_confirm: true },
    fetchImpl,
  });
  if (!created.ok && !isDuplicateEmail(created))
    throw new ProvisionError('Nonproduction login: Auth user creation failed');

  await verifyPasswordAndCloseLocalSession({ origin, publishableKey, email, password, fetchImpl });
  return {
    status: created.ok ? 'created-and-verified' : 'existing-credentials-verified',
    target: target.kind,
    projectRef: branch.project_ref,
    branchId: branch.id,
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    const targetKind = process.env.NONPROD_LOGIN_TARGET;
    const target =
      targetKind === 'integration'
        ? { kind: 'integration' }
        : targetKind === 'preview'
          ? {
              kind: 'preview',
              prNumber: Number(process.env.NONPROD_LOGIN_PR),
              branchName: process.env.NONPROD_LOGIN_BRANCH,
              sha: process.env.NONPROD_LOGIN_SHA,
              baseBranch: process.env.NONPROD_LOGIN_BASE_BRANCH,
            }
          : null;
    const result = await provisionNonproductionLogin({
      target,
      email: process.env.NONPROD_LOGIN_EMAIL,
      password: process.env.NONPROD_LOGIN_PASSWORD,
      supabaseToken: process.env.SUPABASE_PREVIEW_PROVISION_TOKEN,
      githubToken: process.env.GITHUB_TOKEN,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof ProvisionError ? error.message : 'Nonproduction login: failed');
    process.exitCode = 1;
  }
}
