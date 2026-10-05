const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_REPOSITORY = 'Dayopt/dayopt';
const GITHUB_REPOSITORY_API_URL = `${GITHUB_API_ORIGIN}/repos/${GITHUB_REPOSITORY}`;
const GITHUB_API_VERSION = '2022-11-28';
const VERCEL_PREVIEW_CONTEXT = 'Vercel – product';
const VERCEL_PREVIEW_ENVIRONMENT = 'Preview – product';
const VERCEL_CREATOR = Object.freeze({ id: 35613825, login: 'vercel[bot]', type: 'Bot' });
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_PROVIDER_COMPLETION_SKEW_MS = 5 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;
const DEPLOYMENT_ID = /^dpl_[a-zA-Z0-9]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const PRODUCT_PREVIEW_HOST = /^product-[a-z0-9]+-dayopt\.vercel\.app$/;
const STATUS_STATES = new Set(['error', 'failure', 'pending', 'success']);
const DEPLOYMENT_STATUS_STATES = new Set([
  'error',
  'failure',
  'inactive',
  'in_progress',
  'queued',
  'pending',
  'success',
]);

class PreviewDeploymentProvenanceError extends Error {}

function requireCondition(condition, message) {
  if (!condition) {
    throw new PreviewDeploymentProvenanceError(`Preview deployment provenance: ${message}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseIsoUtcTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.padEnd(3, '0')),
  };
  const parsed = new Date(0);
  parsed.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  parsed.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  if (
    parsed.getUTCFullYear() !== parts.year ||
    parsed.getUTCMonth() + 1 !== parts.month ||
    parsed.getUTCDate() !== parts.day ||
    parsed.getUTCHours() !== parts.hour ||
    parsed.getUTCMinutes() !== parts.minute ||
    parsed.getUTCSeconds() !== parts.second ||
    parsed.getUTCMilliseconds() !== parts.millisecond
  ) {
    return null;
  }
  return parsed.getTime();
}

function checkedTimestamp(value, nowMs) {
  const timestamp = parseIsoUtcTimestamp(value);
  requireCondition(
    timestamp !== null && timestamp <= nowMs + MAX_CLOCK_SKEW_MS,
    'provider timestamp is invalid or in the future',
  );
  return timestamp;
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function hasNextPage(linkHeader) {
  if (!linkHeader) return false;
  return /<[^>]+>\s*;\s*rel="?next"?(?:\s*[,;]|$)/i.test(linkHeader);
}

async function readBoundedJson(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    requireCondition(/^\d+$/.test(contentLength), 'GitHub response size is invalid');
    requireCondition(Number(contentLength) <= MAX_RESPONSE_BYTES, 'GitHub response is too large');
  }
  const reader = response.body?.getReader();
  requireCondition(reader, 'GitHub response body is missing');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        requireCondition(false, 'GitHub response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new PreviewDeploymentProvenanceError(
      'Preview deployment provenance: GitHub response is invalid',
    );
  }
}

async function readGitHubJson({ url, token, fetchImpl }) {
  requireCondition(url.origin === GITHUB_API_ORIGIN, 'GitHub endpoint is not allowed');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: githubHeaders(token),
    });
  } catch {
    throw new PreviewDeploymentProvenanceError(
      'Preview deployment provenance: GitHub observation failed',
    );
  }
  requireCondition(response.ok && response.redirected !== true, 'GitHub observation failed');
  if (response.url) {
    requireCondition(response.url === url.href, 'GitHub response redirected');
  }
  const body = await readBoundedJson(response);
  return { body, hasNextPage: hasNextPage(response.headers.get('link')) };
}

function apiUrl(path, query = {}) {
  const url = new URL(path, GITHUB_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

async function readPaginatedArray({ path, query, token, fetchImpl, nowMs, label }) {
  const items = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { body, hasNextPage: linkedNextPage } = await readGitHubJson({
      url: apiUrl(path, { ...query, per_page: PAGE_SIZE, page }),
      token,
      fetchImpl,
    });
    requireCondition(Array.isArray(body) && body.length <= PAGE_SIZE, `${label} list is invalid`);
    for (const item of body) {
      requireCondition(isRecord(item), `${label} record is invalid`);
      const id = parsePositiveSafeInteger(item.id);
      requireCondition(id !== null && !ids.has(id), `${label} record identity is ambiguous`);
      ids.add(id);
      items.push({ record: item, id, createdAt: checkedTimestamp(item.created_at, nowMs) });
    }
    if (body.length < PAGE_SIZE && !linkedNextPage) return items;
  }
  throw new PreviewDeploymentProvenanceError(
    `Preview deployment provenance: ${label} pagination limit exceeded`,
  );
}

function validateRequest({ sha, deploymentId, branchName, prNumber, githubToken, now }) {
  requireCondition(
    typeof sha === 'string' && SHA.test(sha) && DEPLOYMENT_ID.test(deploymentId ?? ''),
    'invalid candidate SHA or deployment ID',
  );
  requireCondition(
    typeof branchName === 'string' &&
      branchName.length <= 200 &&
      SAFE_BRANCH.test(branchName) &&
      !branchName.includes('..') &&
      !branchName.split('/').some((part) => part.endsWith('.')) &&
      !['main', 'integration'].includes(branchName.toLowerCase()),
    'invalid candidate branch',
  );
  requireCondition(Number.isSafeInteger(prNumber) && prNumber > 0, 'invalid candidate PR');
  requireCondition(
    typeof githubToken === 'string' &&
      githubToken.length > 0 &&
      githubToken === githubToken.trim() &&
      !/[\r\n\s]/.test(githubToken),
    'GitHub read credential is required',
  );
  requireCondition(typeof now === 'function', 'observation clock is invalid');
  const nowValue = now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  requireCondition(Number.isFinite(nowMs), 'observation clock is invalid');
  return { sha: sha.toLowerCase(), nowMs };
}

function validatePullRequest(
  pullRequest,
  { sha, branchName, prNumber, pullRequestPolicy, mergeCommitSha },
) {
  const repositoryId = pullRequest?.base?.repo?.id;
  const stateIsAllowed =
    pullRequestPolicy === 'open'
      ? pullRequest.state === 'open' && pullRequest.draft === false
      : pullRequestPolicy === 'merged'
        ? pullRequest.state === 'closed' && pullRequest.merged === true
        : ['open', 'closed'].includes(pullRequest.state) && typeof pullRequest.draft === 'boolean';
  requireCondition(
    pullRequest?.number === prNumber && stateIsAllowed,
    pullRequestPolicy === 'open'
      ? 'candidate PR is not open and ready'
      : pullRequestPolicy === 'merged'
        ? 'candidate PR is not merged'
        : 'candidate PR identity is unavailable',
  );
  requireCondition(
    pullRequest.head?.repo?.full_name === GITHUB_REPOSITORY &&
      pullRequest.head.repo.fork === false &&
      pullRequest.base?.repo?.full_name === GITHUB_REPOSITORY &&
      Number.isSafeInteger(repositoryId) &&
      repositoryId > 0 &&
      pullRequest.head.repo.id === repositoryId,
    'candidate PR must be internal to Dayopt/dayopt',
  );
  requireCondition(
    pullRequest.head.ref === branchName &&
      typeof pullRequest.head.sha === 'string' &&
      SHA.test(pullRequest.head.sha) &&
      (pullRequestPolicy !== 'open' || pullRequest.head.sha.toLowerCase() === sha) &&
      (pullRequestPolicy !== 'merged' ||
        (pullRequest.base.ref === 'integration' &&
          pullRequest.merge_commit_sha === mergeCommitSha)),
    pullRequestPolicy === 'open'
      ? 'candidate PR head differs'
      : pullRequestPolicy === 'merged'
        ? 'candidate PR merge binding differs'
        : 'candidate PR branch identity differs',
  );
  requireCondition(
    ['main', 'integration'].includes(pullRequest.base.ref),
    'candidate PR base is not allowed',
  );
}

async function verifyMergedCommitHistory({ sha, mergeCommitSha, workflowSha, token, fetchImpl }) {
  requireCondition(
    SHA.test(mergeCommitSha ?? '') && SHA.test(workflowSha ?? ''),
    'merged Integration history binding is invalid',
  );
  const mergeSha = mergeCommitSha.toLowerCase();
  const { body: mergeCommit } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/git/commits/${mergeSha}`),
    token,
    fetchImpl,
  });
  requireCondition(
    mergeCommit?.sha?.toLowerCase() === mergeSha &&
      Array.isArray(mergeCommit.parents) &&
      mergeCommit.parents.length === 2 &&
      SHA.test(mergeCommit.parents[0]?.sha ?? '') &&
      mergeCommit.parents[1]?.sha?.toLowerCase() === sha.toLowerCase(),
    'merged Integration commit does not contain the candidate as its second parent',
  );
  const { body: comparison } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/compare/${mergeSha}...${workflowSha}`),
    token,
    fetchImpl,
  });
  requireCondition(
    ['ahead', 'identical'].includes(comparison?.status) &&
      comparison.merge_base_commit?.sha?.toLowerCase() === mergeSha &&
      Number.isSafeInteger(comparison.ahead_by) &&
      Number.isSafeInteger(comparison.behind_by) &&
      comparison.behind_by === 0,
    'merged Integration commit is not in the trusted workflow history',
  );
}

function validateCreator(creator) {
  requireCondition(
    creator?.id === VERCEL_CREATOR.id &&
      creator.login === VERCEL_CREATOR.login &&
      creator.type === VERCEL_CREATOR.type,
    'provider creator is not trusted',
  );
}

function newestUnique(rows, label) {
  requireCondition(rows.length > 0, `${label} is missing`);
  const sorted = [...rows].sort(
    (left, right) => right.createdAt - left.createdAt || right.id - left.id,
  );
  requireCondition(
    sorted.length === 1 || sorted[0].createdAt !== sorted[1].createdAt,
    `${label} is ambiguous`,
  );
  return sorted[0];
}

function validateCommitStatus(status, deploymentId) {
  requireCondition(status.state === 'success', 'latest Product commit status is not successful');
  validateCreator(status.creator);
  let target;
  try {
    target = new URL(status.target_url);
  } catch {
    throw new PreviewDeploymentProvenanceError(
      'Preview deployment provenance: Product commit status URL is invalid',
    );
  }
  const suffix = deploymentId.slice(4);
  requireCondition(
    target.protocol === 'https:' &&
      target.hostname === 'vercel.com' &&
      target.port === '' &&
      target.username === '' &&
      target.password === '' &&
      target.search === '' &&
      target.hash === '' &&
      target.pathname === `/dayopt/product/${suffix}`,
    'Product commit status does not identify the requested Vercel deployment',
  );
}

function validateDeploymentOrigin(value) {
  requireCondition(typeof value === 'string', 'deployment origin is missing');
  let originUrl;
  try {
    originUrl = new URL(value);
  } catch {
    throw new PreviewDeploymentProvenanceError(
      'Preview deployment provenance: deployment origin is invalid',
    );
  }
  requireCondition(
    originUrl.protocol === 'https:' &&
      originUrl.username === '' &&
      originUrl.password === '' &&
      originUrl.port === '' &&
      originUrl.pathname === '/' &&
      originUrl.search === '' &&
      originUrl.hash === '' &&
      PRODUCT_PREVIEW_HOST.test(originUrl.hostname) &&
      (value === originUrl.origin || value === `${originUrl.origin}/`),
    'deployment origin is not an immutable Product Preview host',
  );
  return originUrl.origin;
}

function validateDeploymentRecord(row, sha) {
  const deployment = row.record;
  requireCondition(
    deployment.sha === sha &&
      deployment.ref?.toLowerCase() === sha &&
      deployment.environment === VERCEL_PREVIEW_ENVIRONMENT,
    'latest GitHub deployment does not match the candidate SHA and Product Preview',
  );
}

function validateLatestDeployment(row, sha) {
  const deployment = row.record;
  validateDeploymentRecord(row, sha);
  requireCondition(
    deployment.task === 'deploy' &&
      deployment.original_environment === VERCEL_PREVIEW_ENVIRONMENT &&
      deployment.production_environment === false &&
      deployment.repository_url === GITHUB_REPOSITORY_API_URL,
    'latest GitHub deployment is not the nonproduction Product deployment',
  );
  validateCreator(deployment.creator);
}

function validateDeploymentStatus(status, deploymentId) {
  requireCondition(
    status.state === 'success' && status.environment === VERCEL_PREVIEW_ENVIRONMENT,
    'latest Product deployment status is not successful',
  );
  requireCondition(
    status.repository_url === GITHUB_REPOSITORY_API_URL &&
      status.deployment_url === `${GITHUB_REPOSITORY_API_URL}/deployments/${deploymentId}`,
    'latest Product deployment status repository differs',
  );
  validateCreator(status.creator);
  return validateDeploymentOrigin(status.environment_url);
}

/**
 * Observe the trusted Vercel Product Preview deployment attached to an internal
 * PR. Merged validation binds the original candidate SHA to an Integration
 * merge; cleanup policy is reserved for an already-pinned run.
 * @param {{ sha:string, deploymentId:string, branchName:string, prNumber:number, githubToken:string, pullRequestPolicy?:'open'|'merged'|'cleanup', mergeCommitSha?:string, workflowSha?:string, fetchImpl?:typeof fetch, now?:()=>Date }} options
 * @returns {Promise<{ origin:string, providerEvidence:Record<string, string|number> }>}
 */
export async function observeProductPreviewDeployment({
  sha: inputSha,
  deploymentId,
  branchName,
  prNumber,
  githubToken,
  pullRequestPolicy = 'open',
  mergeCommitSha = undefined,
  workflowSha = undefined,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  requireCondition(
    ['open', 'merged', 'cleanup'].includes(pullRequestPolicy) &&
      (pullRequestPolicy === 'merged'
        ? typeof mergeCommitSha === 'string' &&
          SHA.test(mergeCommitSha) &&
          typeof workflowSha === 'string' &&
          SHA.test(workflowSha)
        : mergeCommitSha === undefined),
    'candidate PR policy is invalid',
  );
  const { sha, nowMs } = validateRequest({
    sha: inputSha,
    deploymentId,
    branchName,
    prNumber,
    githubToken,
    now,
  });
  const token = githubToken;

  const { body: pullRequest } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/pulls/${prNumber}`),
    token,
    fetchImpl,
  });
  validatePullRequest(pullRequest, {
    sha,
    branchName,
    prNumber,
    pullRequestPolicy,
    mergeCommitSha,
  });
  if (pullRequestPolicy === 'merged') {
    await verifyMergedCommitHistory({
      sha,
      mergeCommitSha,
      workflowSha,
      token,
      fetchImpl,
    });
  }

  const commitStatuses = await readPaginatedArray({
    path: `/repos/${GITHUB_REPOSITORY}/commits/${sha}/statuses`,
    query: {},
    token,
    fetchImpl,
    nowMs,
    label: 'commit status',
  });
  const productStatuses = commitStatuses.filter(
    ({ record }) => record.context === VERCEL_PREVIEW_CONTEXT,
  );
  const latestCommitStatus = newestUnique(productStatuses, 'Product commit status');
  validateCommitStatus(latestCommitStatus.record, deploymentId);

  const deployments = await readPaginatedArray({
    path: `/repos/${GITHUB_REPOSITORY}/deployments`,
    query: { sha, environment: VERCEL_PREVIEW_ENVIRONMENT },
    token,
    fetchImpl,
    nowMs,
    label: 'deployment',
  });
  for (const row of deployments) validateDeploymentRecord(row, sha);
  const latestDeployment = newestUnique(deployments, 'Product deployment');
  validateLatestDeployment(latestDeployment, sha);

  const deploymentStatuses = await readPaginatedArray({
    path: `/repos/${GITHUB_REPOSITORY}/deployments/${latestDeployment.id}/statuses`,
    query: {},
    token,
    fetchImpl,
    nowMs,
    label: 'deployment status',
  });
  const latestDeploymentStatus = newestUnique(deploymentStatuses, 'Product deployment status');
  const origin = validateDeploymentStatus(latestDeploymentStatus.record, latestDeployment.id);

  requireCondition(
    latestDeployment.createdAt <= latestDeploymentStatus.createdAt &&
      Math.abs(latestCommitStatus.createdAt - latestDeploymentStatus.createdAt) <=
        MAX_PROVIDER_COMPLETION_SKEW_MS,
    'Vercel provider records cannot be uniquely associated',
  );
  const competingDeployments = deployments.filter(
    (row) =>
      row.id !== latestDeployment.id &&
      Math.abs(row.createdAt - latestDeploymentStatus.createdAt) <= MAX_PROVIDER_COMPLETION_SKEW_MS,
  );
  requireCondition(competingDeployments.length === 0, 'Vercel deployment association is ambiguous');

  const observedAtValue = now();
  const observedAtMs =
    observedAtValue instanceof Date ? observedAtValue.getTime() : Date.parse(observedAtValue);
  requireCondition(Number.isFinite(observedAtMs), 'observation clock is invalid');
  const observedAt = new Date(observedAtMs).toISOString();
  return {
    origin,
    providerEvidence: {
      provider: 'vercel',
      repository: GITHUB_REPOSITORY,
      environment: VERCEL_PREVIEW_ENVIRONMENT,
      sha,
      branchName,
      prNumber,
      vercelDeploymentId: deploymentId,
      githubDeploymentId: latestDeployment.id,
      githubDeploymentStatusId: latestDeploymentStatus.id,
      githubCommitStatusId: latestCommitStatus.id,
      creatorId: VERCEL_CREATOR.id,
      deploymentCreatedAt: new Date(latestDeployment.createdAt).toISOString(),
      deploymentStatusCreatedAt: new Date(latestDeploymentStatus.createdAt).toISOString(),
      commitStatusCreatedAt: new Date(latestCommitStatus.createdAt).toISOString(),
      observedAt,
    },
  };
}
