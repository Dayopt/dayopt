import { appendFileSync, readFileSync } from 'node:fs';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const REPOSITORY = 'Dayopt/dayopt';
const REPOSITORY_ID = 1006944000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[a-f0-9]{40}$/;

class TrustError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new TrustError(`Nonproduction login trust: ${message}`);
}

function validateBranch(value) {
  requireCondition(
    typeof value === 'string' &&
      BRANCH.test(value) &&
      !value.includes('..') &&
      !value.split('/').some((segment) => !segment || segment === '.' || segment === '..'),
    'branch name is invalid',
  );
  return value;
}

function validatePullRequest(pr, { number, sha, headBranch, baseBranch }) {
  requireCondition(
    pr?.number === number &&
      pr.state === 'open' &&
      pr.draft === false &&
      ['main', 'integration'].includes(baseBranch) &&
      pr.base?.ref === baseBranch &&
      pr.base?.repo?.full_name === REPOSITORY &&
      pr.base?.repo?.id === REPOSITORY_ID &&
      pr.head?.repo?.full_name === REPOSITORY &&
      pr.head?.repo?.id === REPOSITORY_ID &&
      pr.head?.repo?.fork === false &&
      pr.head?.sha === sha &&
      pr.head?.ref === headBranch,
    'PR is not a current, open internal candidate',
  );
  return { target: 'preview', prNumber: number, sha, branchName: headBranch, baseBranch };
}

async function readPullRequest({ number, token, fetchImpl }) {
  requireCondition(typeof token === 'string' && token.trim(), 'GitHub token is missing');
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/pulls/${number}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    requireCondition(response.ok, 'live PR verification failed');
    return await response.json();
  } catch (error) {
    if (error instanceof TrustError) throw error;
    throw new TrustError('Nonproduction login trust: live PR verification failed');
  }
}

function resolvePreviewTarget(pr, { number, sha, headBranch, baseBranch }) {
  const target = validatePullRequest(pr, { number, sha, headBranch, baseBranch });
  return target;
}

export async function resolveNonproductionLoginTarget({
  eventName,
  event,
  ref,
  repository = REPOSITORY,
  token = '',
  fetchImpl = fetch,
}) {
  requireCondition(repository === REPOSITORY, 'repository is not allowed');
  if (eventName === 'pull_request_target') {
    const pullRequest = event?.pull_request;
    const number = pullRequest?.number;
    const sha = pullRequest?.head?.sha;
    const headBranch = validateBranch(pullRequest?.head?.ref);
    const baseBranch = pullRequest?.base?.ref;
    const refMatchesTrustedBranch = ref === 'refs/heads/main' || ref === `refs/heads/${baseBranch}`;
    requireCondition(
      Number.isSafeInteger(number) &&
        number > 0 &&
        SHA.test(sha ?? '') &&
        ['main', 'integration'].includes(baseBranch) &&
        refMatchesTrustedBranch,
      'PR identifiers are invalid',
    );
    const live = await readPullRequest({ number, token, fetchImpl });
    const target = resolvePreviewTarget(live, {
      number,
      sha,
      headBranch,
      baseBranch,
    });
    const latest = await readPullRequest({ number, token, fetchImpl });
    validatePullRequest(latest, { number, sha, headBranch, baseBranch });
    return target;
  }

  requireCondition(eventName === 'workflow_dispatch', 'event is not allowed');
  requireCondition(
    ref === 'refs/heads/integration',
    'manual dispatch must use trusted Integration ref',
  );
  const inputs = event?.inputs;
  if (inputs?.target === 'integration') {
    return { target: 'integration' };
  }

  requireCondition(inputs?.target === 'preview', 'manual target is invalid');
  const number = /^[1-9]\d{0,8}$/.test(inputs.preview_pr ?? '') ? Number(inputs.preview_pr) : NaN;
  const sha = (inputs.preview_sha ?? '').toLowerCase();
  requireCondition(Number.isSafeInteger(number) && SHA.test(sha), 'manual PR identity is invalid');
  const live = await readPullRequest({ number, token, fetchImpl });
  const baseBranch = live?.base?.ref;
  requireCondition(['main', 'integration'].includes(baseBranch), 'PR base branch is not allowed');
  const target = resolvePreviewTarget(live, {
    number,
    sha,
    headBranch: validateBranch(live?.head?.ref),
    baseBranch,
  });
  const latest = await readPullRequest({ number, token, fetchImpl });
  validatePullRequest(latest, {
    number,
    sha,
    headBranch: target.branchName,
    baseBranch,
  });
  return target;
}

export function writeTrustedTarget(target, outputPath) {
  requireCondition(
    typeof outputPath === 'string' && outputPath.length > 0,
    'workflow output is missing',
  );
  const fields =
    target.target === 'integration'
      ? { target: 'integration', pr_number: '', sha: '', branch_name: '' }
      : {
          target: 'preview',
          pr_number: String(target.prNumber),
          sha: target.sha,
          branch_name: target.branchName,
          base_branch: target.baseBranch,
        };
  appendFileSync(
    outputPath,
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600 },
  );
}

if (isDirectExecution(import.meta.url)) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const target = await resolveNonproductionLoginTarget({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      ref: process.env.GITHUB_REF,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
    writeTrustedTarget(target, process.env.GITHUB_OUTPUT);
    console.log('Nonproduction login trust: target verified');
  } catch (error) {
    console.error(
      error instanceof TrustError ? error.message : 'Nonproduction login trust: failed',
    );
    process.exitCode = 1;
  }
}
