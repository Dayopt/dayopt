import { createHash } from 'node:crypto';

import { verifyPreviewEnvironmentBoundary } from '../ci/preview-cloud-trust.mjs';
import { prepareFixtureAuthority } from './preview-fixture-authority.mjs';

const REPOSITORY = 'Dayopt/dayopt';
const REPOSITORY_ID = 1006944000;
const OWNER_ID = 254866353;
const WORKFLOW = '.github/workflows/ci.yml';
const ERROR = 'Preview fixture handoff trust is invalid';

export const PREVIEW_FIXTURE_HANDOFF_CONTRACT = Object.freeze({
  trustJob: 'Preview candidate trust',
  consumerJob: 'Consume prepared Preview fixtures',
  provisionJob: 'Provision Preview fixtures',
  publicKeyUploadStep: 'Publish Preview fixture public key',
  envelopeUploadStep: 'Publish encrypted Preview fixtures',
  candidateCheckout: 'Checkout reviewed Preview candidate',
  candidateStep: 'Execute prepared Preview tests',
});

function requireCondition(condition) {
  if (!condition) throw new Error();
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function time(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new Error();
  const parsed = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  requireCondition(
    Number.isFinite(parsed) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      Number(value.slice(11, 13)) < 24 &&
      Number(value.slice(14, 16)) < 60 &&
      Number(value.slice(17, 19)) < 60,
  );
  return parsed;
}
function prepared(input, role) {
  requireCondition(['public-key', 'envelope'].includes(role));
  const bound = prepareFixtureAuthority(input);
  requireCondition(bound.operation === 'provision');
  return bound;
}
function artifactName(bound, role) {
  const digest = createHash('sha256').update(JSON.stringify(bound)).digest('hex');
  return `preview-fixture-${role}-${bound.execution.runId}-${bound.execution.attempt}-${digest}`;
}

/** Public naming only, never a proof of artifact authenticity. */
export function previewFixtureHandoffArtifactName(input, role) {
  try {
    return artifactName(prepared(input, role), role);
  } catch {
    throw new Error(ERROR);
  }
}

async function boundedJson(response) {
  requireCondition(response.status === 200 && response.body && !response.redirected);
  requireCondition(!/(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/i.test(response.headers.get('link') ?? ''));
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= 1_048_576);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function repository(repo) {
  requireCondition(
    repo?.id === REPOSITORY_ID &&
      repo.full_name === REPOSITORY &&
      repo.owner?.id === OWNER_ID &&
      repo.owner.login === 'Dayopt',
  );
}

function assertRun(run, bound) {
  requireCondition(
    run?.id === bound.execution.runId &&
      run.run_attempt === bound.execution.attempt &&
      run.status === 'in_progress' &&
      run.conclusion === null &&
      run.event === 'workflow_dispatch' &&
      run.head_branch === 'integration' &&
      run.head_sha === bound.execution.workflowSha &&
      [WORKFLOW, `${WORKFLOW}@refs/heads/integration`].includes(run.path),
  );
  repository(run.repository);
  repository(run.head_repository);
  const created = time(run.created_at);
  const started = time(run.run_started_at);
  const updated = time(run.updated_at);
  requireCondition(created <= started && started <= updated);
  return { created, started };
}

function list(body, key) {
  requireCondition(
    record(body) &&
      Array.isArray(body[key]) &&
      Number.isSafeInteger(body.total_count) &&
      body.total_count > 0 &&
      body.total_count <= 100 &&
      body.total_count === body[key].length &&
      body[key].every(record),
  );
  return body[key];
}

function one(items, name) {
  const matching = items.filter((item) => item.name === name);
  requireCondition(matching.length === 1);
  return matching[0];
}

function job(job, bound, attempt) {
  requireCondition(
    positive(job.id) &&
      job.run_id === bound.execution.runId &&
      job.head_sha === bound.execution.workflowSha &&
      Array.isArray(job.steps) &&
      job.steps.length <= 100 &&
      job.steps.every(record),
  );
  const started = time(job.started_at);
  requireCondition(started >= attempt.started);
  if (job.status === 'completed') {
    requireCondition(job.conclusion === 'success');
    const completed = time(job.completed_at);
    requireCondition(completed >= started);
    return { started, completed };
  }
  requireCondition(
    job.status === 'in_progress' && job.conclusion === null && job.completed_at === null,
  );
  return { started, completed: null };
}

function assertJobs(body, bound, attempt, role) {
  const jobs = list(body, 'jobs');
  const trust = one(jobs, PREVIEW_FIXTURE_HANDOFF_CONTRACT.trustJob);
  const consumer = one(jobs, PREVIEW_FIXTURE_HANDOFF_CONTRACT.consumerJob);
  const provision = one(jobs, PREVIEW_FIXTURE_HANDOFF_CONTRACT.provisionJob);
  const trustTime = job(trust, bound, attempt);
  requireCondition(trust.status === 'completed' && trustTime.completed !== null);
  const consumerTime = job(consumer, bound, attempt);
  requireCondition(
    consumer.status === 'in_progress' && consumerTime.started >= trustTime.completed,
  );
  requireCondition(new Set([trust.id, consumer.id, provision.id]).size === 3);
  const candidate = one(consumer.steps, PREVIEW_FIXTURE_HANDOFF_CONTRACT.candidateStep);
  const checkout = one(consumer.steps, PREVIEW_FIXTURE_HANDOFF_CONTRACT.candidateCheckout);
  for (const step of [checkout, candidate])
    requireCondition(
      positive(step.number) &&
        step.status === 'queued' &&
        step.conclusion === null &&
        step.started_at === null &&
        step.completed_at === null,
    );
  const publicKeyStep = one(consumer.steps, PREVIEW_FIXTURE_HANDOFF_CONTRACT.publicKeyUploadStep);
  const publicKeyTime = upload(publicKeyStep, consumerTime);
  requireCondition(publicKeyStep.number < checkout.number && checkout.number < candidate.number);
  let producer = consumer;
  let uploadTime = publicKeyTime;
  if (role === 'envelope') {
    const provisionTime = job(provision, bound, attempt);
    requireCondition(provisionTime.started >= trustTime.completed);
    const envelopeStep = one(provision.steps, PREVIEW_FIXTURE_HANDOFF_CONTRACT.envelopeUploadStep);
    uploadTime = upload(envelopeStep, provisionTime);
    requireCondition(uploadTime.started >= publicKeyTime.completed);
    producer = provision;
  } else {
    requireCondition(
      positive(provision.id) &&
        provision.run_id === bound.execution.runId &&
        provision.head_sha === bound.execution.workflowSha &&
        ['queued', 'in_progress'].includes(provision.status) &&
        provision.conclusion === null &&
        provision.completed_at === null,
    );
    if (provision.status === 'in_progress') {
      const provisionTime = job(provision, bound, attempt);
      requireCondition(provisionTime.started >= trustTime.completed);
    } else requireCondition(provision.started_at === null);
  }
  requireCondition(time(bound.intent.createdAt) >= attempt.started);
  requireCondition(time(bound.intent.createdAt) <= publicKeyTime.started);
  return { producerId: producer.id, ...uploadTime };
}

function upload(step, producer) {
  requireCondition(
    positive(step.number) && step.status === 'completed' && step.conclusion === 'success',
  );
  const started = time(step.started_at);
  const completed = time(step.completed_at);
  requireCondition(
    started >= producer.started &&
      completed >= started &&
      (producer.completed === null || completed <= producer.completed),
  );
  return { started, completed };
}

function assertArtifact(body, bound, role, producer, attempt) {
  const artifact = one(list(body, 'artifacts'), artifactName(bound, role));
  const created = time(artifact.created_at);
  const metadata = artifact.workflow_run;
  requireCondition(
    positive(artifact.id) &&
      positive(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= 131_072 &&
      artifact.expired === false &&
      typeof artifact.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
      time(artifact.expires_at) > Math.max(created, Date.now()) &&
      created >= attempt.started &&
      // Jobs/steps may have second precision; compare complete second buckets.
      Math.floor(created / 1000) >= Math.floor(producer.started / 1000) &&
      Math.floor(created / 1000) <= Math.floor(producer.completed / 1000) &&
      metadata?.id === bound.execution.runId &&
      metadata.repository_id === REPOSITORY_ID &&
      metadata.head_repository_id === REPOSITORY_ID &&
      metadata.head_branch === 'integration' &&
      metadata.head_sha === bound.execution.workflowSha,
  );
  return { artifactId: artifact.id, digest: artifact.digest, name: artifact.name };
}

/**
 * Read-only metadata verification before consumer candidate checkout/install.
 * Artifact metadata has no writer job ID or attempt: this is NOT a cryptographic
 * sender signature. Trusted Integration source must sequence all candidate code
 * after verified decryption. Download/digest verification/ZIP decoding are caller
 * duties. The workflow and transfer are not connected by this component.
 */
export async function verifyPreviewFixtureHandoffTrust(options) {
  try {
    requireCondition(
      record(options) &&
        ['input', 'role', 'token'].every((key) => Object.hasOwn(options, key)) &&
        Object.keys(options).every((key) => ['input', 'role', 'token', 'fetchImpl'].includes(key)),
    );
    const { input, role, token, fetchImpl = fetch } = options;
    const bound = prepared(input, role);
    requireCondition(typeof token === 'string' && token.trim() && token.length <= 16_384);
    const safeToken = token.trim();
    const checkedFetch = async (url, init) => {
      requireCondition(new URL(url).origin === 'https://api.github.com');
      const body = await boundedJson(await fetchImpl(url, init));
      return Response.json(body);
    };
    const read = async (path, query = {}) => {
      const url = new URL(`/repos/${REPOSITORY}${path}`, 'https://api.github.com');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
      const response = await checkedFetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${safeToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      return response.json();
    };
    await verifyPreviewEnvironmentBoundary({ token: safeToken, fetchImpl: checkedFetch });
    const runPath = `/actions/runs/${bound.execution.runId}`;
    const latest = assertRun(await read(runPath), bound);
    const attemptPath = `${runPath}/attempts/${bound.execution.attempt}`;
    const attempt = assertRun(await read(attemptPath), bound);
    requireCondition(attempt.created === latest.created);
    const jobsPath = `${attemptPath}/jobs`;
    const query = { per_page: 100, page: 1 };
    const producer = assertJobs(await read(jobsPath, query), bound, attempt, role);
    const artifact = assertArtifact(
      await read(`${runPath}/artifacts`, query),
      bound,
      role,
      producer,
      attempt,
    );
    const finalProducer = assertJobs(await read(jobsPath, query), bound, attempt, role);
    requireCondition(
      finalProducer.producerId === producer.producerId &&
        finalProducer.started === producer.started &&
        finalProducer.completed === producer.completed,
    );
    const finalRun = assertRun(await read(runPath), bound);
    requireCondition(finalRun.created === latest.created && finalRun.started === latest.started);
    return artifact;
  } catch {
    throw new Error(ERROR);
  }
}
