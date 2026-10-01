import { validateCloudIntent } from '../ci/preview-cloud-intent.mjs';
import { verifyPreviewEnvironmentBoundary } from '../ci/preview-cloud-trust.mjs';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_REPOSITORY = 'Dayopt/dayopt';
const GITHUB_API_VERSION = '2022-11-28';
const PREVIEW_INTENT_WORKFLOW = '.github/workflows/ci.yml';
const PREVIEW_INTENT_ARTIFACT_PREFIX = 'preview-intent';
const JOB_TRUST = 'Preview candidate trust';
const JOB_E2E = 'Remote Preview login and CRUD';
const STEP_E2E = 'Pinned remote login, desktop and mobile CRUD, and cleanup';
const FAILED_E2E_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

class PreviewCloudRecoveryTrustError extends Error {}

function requireCondition(condition, message) {
  if (!condition) {
    throw new PreviewCloudRecoveryTrustError(`Preview Cloud recovery trust: ${message}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function readGitHubJson({ url, token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: githubHeaders(token),
    });
    requireCondition(response.ok, 'GitHub read failed');
    const body = await response.json();
    return {
      body,
      hasNextPage: /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/i.test(response.headers.get('link') ?? ''),
    };
  } catch (error) {
    if (error instanceof PreviewCloudRecoveryTrustError) throw error;
    throw new PreviewCloudRecoveryTrustError('Preview Cloud recovery trust: GitHub read failed');
  }
}

function apiUrl(path, query = {}) {
  const url = new URL(path, GITHUB_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

function parsePositiveSafeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeIsoDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function workflowPathMatches(value, ref) {
  if (typeof value !== 'string') return false;
  return value === PREVIEW_INTENT_WORKFLOW || value === `${PREVIEW_INTENT_WORKFLOW}@${ref}`;
}

function assertSourceRunMatchesIntent(run, intent, sourceRunId, sourceAttempt) {
  requireCondition(
    run?.id === sourceRunId &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt >= sourceAttempt &&
      run.status === 'completed' &&
      typeof run.conclusion === 'string' &&
      run.conclusion.length > 0,
    'source run is not completed or its latest attempt is still active',
  );
  requireCondition(
    run.event === 'workflow_dispatch' &&
      run.head_branch === 'integration' &&
      run.head_sha === intent.workflowSha &&
      workflowPathMatches(run.path, intent.workflowRef),
    'source run workflow binding differs',
  );
  requireCondition(
    run.repository?.full_name === GITHUB_REPOSITORY &&
      run.head_repository?.full_name === GITHUB_REPOSITORY &&
      Number.isSafeInteger(run.repository?.id) &&
      run.repository.id > 0 &&
      run.head_repository?.id === run.repository.id,
    'source run repository binding differs',
  );
  const createdAt = safeIsoDate(run.created_at);
  const updatedAt = safeIsoDate(run.updated_at);
  requireCondition(
    createdAt !== null && updatedAt !== null && createdAt <= updatedAt,
    'source run timestamps are invalid',
  );
  return {
    repositoryId: run.repository.id,
    createdAt,
    updatedAt,
    latestAttempt: run.run_attempt,
  };
}

function assertSourceAttemptMatchesIntent(
  attempt,
  intent,
  sourceRunId,
  sourceAttempt,
  repositoryId,
) {
  requireCondition(
    attempt?.id === sourceRunId &&
      attempt.run_attempt === sourceAttempt &&
      attempt.status === 'completed' &&
      FAILED_E2E_CONCLUSIONS.has(attempt.conclusion),
    'selected source attempt is not a completed failed attempt',
  );
  requireCondition(
    attempt.event === 'workflow_dispatch' &&
      attempt.head_branch === 'integration' &&
      attempt.head_sha === intent.workflowSha &&
      workflowPathMatches(attempt.path, intent.workflowRef),
    'selected source attempt workflow binding differs',
  );
  requireCondition(
    attempt.repository?.full_name === GITHUB_REPOSITORY &&
      attempt.head_repository?.full_name === GITHUB_REPOSITORY &&
      attempt.repository.id === repositoryId &&
      attempt.head_repository.id === repositoryId,
    'selected source attempt repository binding differs',
  );
  const createdAt = safeIsoDate(attempt.created_at);
  const updatedAt = safeIsoDate(attempt.updated_at);
  const runStartedAt = safeIsoDate(attempt.run_started_at);
  requireCondition(
    createdAt !== null &&
      updatedAt !== null &&
      runStartedAt !== null &&
      createdAt <= updatedAt &&
      runStartedAt >= createdAt &&
      runStartedAt <= updatedAt,
    'selected source attempt timestamps are invalid',
  );
  return { createdAt, updatedAt, runStartedAt };
}

async function verifySourceAttemptJobs({ sourceRunId, sourceAttempt, token, fetchImpl }) {
  const { body, hasNextPage } = await readGitHubJson({
    url: apiUrl(
      `/repos/${GITHUB_REPOSITORY}/actions/runs/${sourceRunId}/attempts/${sourceAttempt}/jobs`,
      { per_page: 100, page: 1 },
    ),
    token,
    fetchImpl,
  });
  requireCondition(
    !hasNextPage &&
      isRecord(body) &&
      Array.isArray(body.jobs) &&
      Number.isSafeInteger(body.total_count) &&
      body.total_count === body.jobs.length,
    'source attempt jobs are incomplete',
  );
  const trustJobs = body.jobs.filter((job) => job?.name === JOB_TRUST);
  const legacyJobs = body.jobs.filter(
    (job) => job?.name === JOB_E2E && job.conclusion !== 'skipped',
  );
  const provisionJobs = body.jobs.filter(
    (job) => job?.name === 'Provision Preview fixtures' && job.conclusion !== 'skipped',
  );
  const prepared = provisionJobs.length > 0;
  requireCondition(
    !prepared || legacyJobs.length === 0,
    'legacy and prepared jobs must be exclusive',
  );
  const e2eJobs = prepared ? provisionJobs : legacyJobs;
  const executeStep = prepared ? 'Provision encrypted Preview fixtures' : STEP_E2E;
  requireCondition(
    trustJobs.length === 1 &&
      trustJobs[0].status === 'completed' &&
      trustJobs[0].conclusion === 'success',
    'source trust job did not pass',
  );
  requireCondition(
    e2eJobs.length === 1 &&
      e2eJobs[0].status === 'completed' &&
      (FAILED_E2E_CONCLUSIONS.has(e2eJobs[0].conclusion) ||
        (prepared && e2eJobs[0].conclusion === 'success')) &&
      safeIsoDate(e2eJobs[0].started_at) !== null &&
      safeIsoDate(e2eJobs[0].completed_at) !== null,
    'source Preview E2E job was not a completed interrupted run',
  );
  const executeSteps = e2eJobs[0].steps?.filter((step) => step?.name === executeStep) ?? [];
  requireCondition(
    executeSteps.length === 1 &&
      executeSteps[0].status === 'completed' &&
      safeIsoDate(executeSteps[0].started_at) !== null &&
      safeIsoDate(executeSteps[0].completed_at) !== null &&
      (FAILED_E2E_CONCLUSIONS.has(executeSteps[0].conclusion) ||
        (prepared && executeSteps[0].conclusion === 'success')),
    'source Preview E2E execute step did not fail after starting',
  );
  const jobStartedAt = safeIsoDate(e2eJobs[0].started_at);
  const jobCompletedAt = safeIsoDate(e2eJobs[0].completed_at);
  const stepStartedAt = safeIsoDate(executeSteps[0].started_at);
  const stepCompletedAt = safeIsoDate(executeSteps[0].completed_at);
  requireCondition(
    jobStartedAt !== null &&
      jobCompletedAt !== null &&
      stepStartedAt !== null &&
      stepCompletedAt !== null &&
      jobStartedAt <= stepStartedAt &&
      stepStartedAt <= stepCompletedAt &&
      stepCompletedAt <= jobCompletedAt,
    'source Preview E2E timestamps are inconsistent',
  );
  return { jobStartedAt, jobCompletedAt, stepStartedAt, stepCompletedAt, prepared };
}

async function findIntentArtifact({
  sourceRunId,
  sourceAttempt,
  intent,
  run,
  jobs,
  token,
  fetchImpl,
}) {
  const { body, hasNextPage } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/actions/runs/${sourceRunId}/artifacts`, {
      per_page: 100,
      page: 1,
    }),
    token,
    fetchImpl,
  });
  requireCondition(
    !hasNextPage &&
      isRecord(body) &&
      Array.isArray(body.artifacts) &&
      Number.isSafeInteger(body.total_count) &&
      body.total_count === body.artifacts.length,
    'source artifacts are incomplete',
  );
  const expectedName = `${PREVIEW_INTENT_ARTIFACT_PREFIX}-${sourceRunId}-${sourceAttempt}`;
  const matches = body.artifacts.filter((artifact) => artifact?.name === expectedName);
  requireCondition(matches.length === 1, 'source intent artifact is missing or ambiguous');
  const artifact = matches[0];
  const metadata = artifact.workflow_run;
  const artifactCreatedAt = safeIsoDate(artifact.created_at);
  requireCondition(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 128 * 1024 &&
      artifact.expired === false &&
      typeof artifact.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
      artifactCreatedAt !== null &&
      artifactCreatedAt >= run.createdAt &&
      artifactCreatedAt <= jobs.stepStartedAt &&
      isRecord(metadata) &&
      metadata.id === sourceRunId &&
      metadata.repository_id === run.repositoryId &&
      metadata.head_repository_id === run.repositoryId &&
      metadata.head_branch === 'integration' &&
      metadata.head_sha === intent.workflowSha,
    'source intent artifact metadata binding differs',
  );
  return { id: artifact.id, digest: artifact.digest };
}

/**
 * Verify a failed Integration run and its public intent through read-only GitHub APIs.
 * Artifact bytes must be downloaded and checked by the caller before recovery.
 * @param {{ repository: string, eventName: string, ref: string, token: string, sourceRunId: string | number, sourceAttempt: string | number, intent: object, fetchImpl?: typeof fetch, readOnlyObserver?: boolean }} options
 * @returns {Promise<{ intent: object, artifactId: number, digest: string }>}
 */
export async function verifyPreviewRecoveryTrust({
  repository,
  eventName,
  ref,
  token,
  sourceRunId: sourceRunIdInput,
  sourceAttempt: sourceAttemptInput,
  intent: untrustedIntent,
  fetchImpl = fetch,
  readOnlyObserver = false,
}) {
  requireCondition(
    eventName === (readOnlyObserver ? 'workflow_run' : 'workflow_dispatch'),
    'recovery event is invalid',
  );
  requireCondition(repository === GITHUB_REPOSITORY, 'repository is not allowed');
  requireCondition(
    ref === (readOnlyObserver ? 'refs/heads/main' : 'refs/heads/integration'),
    'recovery source ref is invalid',
  );
  requireCondition(
    typeof token === 'string' && token.trim().length > 0,
    'read-only GitHub token is required',
  );
  const sourceRunId = parsePositiveSafeInteger(sourceRunIdInput);
  const sourceAttempt = parsePositiveSafeInteger(sourceAttemptInput);
  requireCondition(sourceRunId !== null && sourceAttempt !== null, 'invalid source run attempt');
  let intent;
  try {
    intent = validateCloudIntent(untrustedIntent);
  } catch {
    throw new PreviewCloudRecoveryTrustError(
      'Preview Cloud recovery trust: source intent is invalid',
    );
  }
  requireCondition(
    intent.sourceRunId === sourceRunId &&
      intent.sourceAttempt === sourceAttempt &&
      intent.repository === GITHUB_REPOSITORY &&
      intent.workflow === PREVIEW_INTENT_WORKFLOW &&
      intent.workflowRef === 'refs/heads/integration',
    'source intent binding differs',
  );

  const safeToken = token.trim();
  await verifyPreviewEnvironmentBoundary({ token: safeToken, fetchImpl });
  const { body: latestRun } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`),
    token: safeToken,
    fetchImpl,
  });
  const latestBinding = assertSourceRunMatchesIntent(latestRun, intent, sourceRunId, sourceAttempt);
  const { body: sourceAttemptRecord } = await readGitHubJson({
    url: apiUrl(
      `/repos/${GITHUB_REPOSITORY}/actions/runs/${sourceRunId}/attempts/${sourceAttempt}`,
    ),
    token: safeToken,
    fetchImpl,
  });
  const attemptBinding = assertSourceAttemptMatchesIntent(
    sourceAttemptRecord,
    intent,
    sourceRunId,
    sourceAttempt,
    latestBinding.repositoryId,
  );
  const jobBinding = await verifySourceAttemptJobs({
    sourceRunId,
    sourceAttempt,
    token: safeToken,
    fetchImpl,
  });
  const intentCreatedAt = safeIsoDate(intent.createdAt);
  requireCondition(
    intentCreatedAt !== null &&
      intentCreatedAt >= (attemptBinding.runStartedAt ?? attemptBinding.createdAt) &&
      intentCreatedAt <= jobBinding.stepStartedAt &&
      attemptBinding.updatedAt >= jobBinding.jobCompletedAt &&
      latestBinding.updatedAt >= jobBinding.jobCompletedAt,
    'source intent and attempt timestamps are inconsistent',
  );
  const artifact = await findIntentArtifact({
    sourceRunId,
    sourceAttempt,
    intent,
    run: latestBinding,
    jobs: jobBinding,
    token: safeToken,
    fetchImpl,
  });
  const { body: finalRun } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`),
    token: safeToken,
    fetchImpl,
  });
  const finalBinding = assertSourceRunMatchesIntent(finalRun, intent, sourceRunId, sourceAttempt);
  requireCondition(
    finalBinding.latestAttempt === latestBinding.latestAttempt &&
      finalBinding.updatedAt === latestBinding.updatedAt,
    'source run changed during recovery verification',
  );
  return {
    intent,
    artifactId: artifact.id,
    digest: artifact.digest,
    ...(jobBinding.prepared ? { recoveryMode: 'broker' } : {}),
  };
}
