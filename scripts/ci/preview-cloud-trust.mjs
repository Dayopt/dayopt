#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_REPOSITORY = 'Dayopt/dayopt';
const GITHUB_API_VERSION = '2022-11-28';
const PREVIEW_ENVIRONMENT = 'Preview – product';
const SHARED_PREVIEW_REF = 'tilwaprottpyhlfoggbb';
const SHARED_PREVIEW_BRANCH_ID = '4c2ed092-cba3-4f37-98e1-78f61cdf52ed';
const PR_FILES_PER_PAGE = 100;
const PR_FILES_MAX = 3000;
const PR_FILES_MAX_PAGES = PR_FILES_MAX / PR_FILES_PER_PAGE;
const REQUIRED_INPUT_KEYS = [
  'preview_e2e',
  'preview_pr',
  'preview_sha',
  'preview_deployment',
  'preview_db_ref',
  'preview_db_branch',
  'preview_db_mode',
];
const OPTIONAL_RECOVERY_INPUT_KEYS = ['preview_recover_run', 'preview_recover_attempt'];
const SUPPORTED_INPUT_KEYS = [...REQUIRED_INPUT_KEYS, ...OPTIONAL_RECOVERY_INPUT_KEYS];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

class PreviewCloudTrustError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new PreviewCloudTrustError(`Preview Cloud trust: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInputs(requestJson) {
  requireCondition(
    typeof requestJson === 'string' && requestJson.length <= 16_384,
    'invalid workflow input',
  );
  let inputs;
  try {
    inputs = JSON.parse(requestJson);
  } catch {
    throw new PreviewCloudTrustError('Preview Cloud trust: invalid workflow input');
  }
  requireCondition(isRecord(inputs), 'invalid workflow input');
  const inputKeys = Object.keys(inputs);
  requireCondition(
    REQUIRED_INPUT_KEYS.every((key) => Object.hasOwn(inputs, key)) &&
      inputKeys.every((key) => SUPPORTED_INPUT_KEYS.includes(key)),
    'unexpected workflow input fields',
  );
  requireCondition(
    // GitHub's manual dispatch UI omits optional inputs left empty.
    OPTIONAL_RECOVERY_INPUT_KEYS.every((key) => !Object.hasOwn(inputs, key) || inputs[key] === ''),
    'recovery inputs cannot be used for Preview E2E',
  );
  requireCondition(inputs.preview_e2e === true, 'Preview E2E was not explicitly enabled');
  requireCondition(
    typeof inputs.preview_pr === 'string' && /^[1-9]\d{0,8}$/.test(inputs.preview_pr),
    'invalid PR number',
  );
  const prNumber = Number(inputs.preview_pr);
  requireCondition(Number.isSafeInteger(prNumber), 'invalid PR number');
  requireCondition(
    typeof inputs.preview_sha === 'string' && /^[a-fA-F0-9]{40}$/.test(inputs.preview_sha),
    'invalid commit SHA',
  );
  requireCondition(
    typeof inputs.preview_deployment === 'string' &&
      /^dpl_[A-Za-z0-9]+$/.test(inputs.preview_deployment),
    'invalid deployment id',
  );
  requireCondition(
    typeof inputs.preview_db_ref === 'string' && PROJECT_REF.test(inputs.preview_db_ref),
    'invalid database project ref',
  );
  requireCondition(
    typeof inputs.preview_db_branch === 'string' && UUID.test(inputs.preview_db_branch),
    'invalid database branch id',
  );
  requireCondition(
    inputs.preview_db_mode === 'shared' || inputs.preview_db_mode === 'ephemeral',
    'invalid database mode',
  );

  const supabaseProjectRef = inputs.preview_db_ref;
  const supabaseBranchId = inputs.preview_db_branch;
  const databaseMode = inputs.preview_db_mode;
  requireCondition(
    supabaseProjectRef !== SUPABASE_PRODUCTION_PROJECT_REF,
    'production database identity is forbidden',
  );
  if (databaseMode === 'shared') {
    requireCondition(
      supabaseProjectRef === SHARED_PREVIEW_REF && supabaseBranchId === SHARED_PREVIEW_BRANCH_ID,
      'shared database identity does not match the fixed Preview branch',
    );
  } else {
    requireCondition(
      supabaseProjectRef !== SHARED_PREVIEW_REF && supabaseBranchId !== SHARED_PREVIEW_BRANCH_ID,
      'ephemeral database identity must be separate from the shared Preview branch',
    );
  }

  return {
    prNumber,
    sha: inputs.preview_sha.toLowerCase(),
    deploymentId: inputs.preview_deployment,
    supabaseProjectRef,
    supabaseBranchId,
    databaseMode,
  };
}

function safeBranchName(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    !SAFE_BRANCH.test(value) ||
    value.includes('..')
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && !segment.endsWith('.'));
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
    if (error instanceof PreviewCloudTrustError) throw error;
    throw new PreviewCloudTrustError('Preview Cloud trust: GitHub read failed');
  }
}

function apiUrl(path, query = {}) {
  const url = new URL(path, GITHUB_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

export async function verifyPreviewEnvironmentBoundary({ token, fetchImpl }) {
  const environmentPath = `/repos/${GITHUB_REPOSITORY}/environments/${encodeURIComponent(PREVIEW_ENVIRONMENT)}`;
  const { body: environment } = await readGitHubJson({
    url: apiUrl(environmentPath),
    token,
    fetchImpl,
  });
  requireCondition(
    environment?.deployment_branch_policy?.custom_branch_policies === true &&
      environment.deployment_branch_policy.protected_branches === false,
    'Preview environment must use a branch-specific deployment policy',
  );

  const { body: policyList } = await readGitHubJson({
    url: apiUrl(`${environmentPath}/deployment-branch-policies`, { per_page: 100, page: 1 }),
    token,
    fetchImpl,
  });
  requireCondition(
    policyList?.total_count === 1 &&
      Array.isArray(policyList.branch_policies) &&
      policyList.branch_policies.length === 1 &&
      policyList.branch_policies[0]?.name === 'integration' &&
      policyList.branch_policies[0]?.type === 'branch',
    'Preview environment must be restricted to the integration branch',
  );
}

async function readPullRequest({ prNumber, token, fetchImpl }) {
  const { body } = await readGitHubJson({
    url: apiUrl(`/repos/${GITHUB_REPOSITORY}/pulls/${prNumber}`),
    token,
    fetchImpl,
  });
  return body;
}

function validatePullRequest(pullRequest, request) {
  requireCondition(
    pullRequest?.number === request.prNumber &&
      pullRequest.state === 'open' &&
      pullRequest.draft === false,
    'PR must be open and ready for review',
  );
  requireCondition(
    pullRequest.head?.repo?.full_name === GITHUB_REPOSITORY &&
      pullRequest.head.repo.fork === false &&
      pullRequest.base?.repo?.full_name === GITHUB_REPOSITORY,
    'PR source and destination must be internal Dayopt/dayopt branches',
  );
  requireCondition(
    typeof pullRequest.head.sha === 'string' && pullRequest.head.sha.toLowerCase() === request.sha,
    'PR head does not match the requested commit SHA',
  );
  requireCondition(
    pullRequest.base.ref === 'main' || pullRequest.base.ref === 'integration',
    'PR base must be main or integration',
  );
  requireCondition(
    safeBranchName(pullRequest.head.ref) &&
      !['main', 'integration'].includes(pullRequest.head.ref.toLowerCase()),
    'PR source branch is not allowed',
  );
  return pullRequest.head.ref;
}

function isSupabasePath(path) {
  return path.split('/')[0]?.toLowerCase() === 'supabase';
}

function validateGitHubPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

async function verifySharedDatabaseChanges({ request, token, fetchImpl }) {
  if (request.databaseMode !== 'shared') return;
  const files = [];
  let complete = false;
  for (let page = 1; page <= PR_FILES_MAX_PAGES; page++) {
    const { body, hasNextPage } = await readGitHubJson({
      url: apiUrl(`/repos/${GITHUB_REPOSITORY}/pulls/${request.prNumber}/files`, {
        per_page: PR_FILES_PER_PAGE,
        page,
      }),
      token,
      fetchImpl,
    });
    requireCondition(
      Array.isArray(body) && body.length <= PR_FILES_PER_PAGE,
      'PR file list is invalid',
    );
    for (const file of body) {
      requireCondition(
        isRecord(file) &&
          validateGitHubPath(file.filename) &&
          (file.previous_filename === undefined || validateGitHubPath(file.previous_filename)),
        'PR file list is invalid',
      );
      requireCondition(
        !isSupabasePath(file.filename) &&
          (file.previous_filename === undefined || !isSupabasePath(file.previous_filename)),
        'shared database PRs cannot change Supabase files',
      );
      files.push(file.filename);
    }
    requireCondition(files.length < PR_FILES_MAX, 'PR file list reached the GitHub API limit');
    const morePages = hasNextPage || body.length === PR_FILES_PER_PAGE;
    if (!morePages) {
      complete = true;
      break;
    }
    requireCondition(
      page < PR_FILES_MAX_PAGES,
      'PR file list may be truncated at the GitHub API limit',
    );
  }
  requireCondition(complete && files.length > 0, 'complete PR file list is required');
}

/**
 * Verify a manual Cloud Preview request against live, read-only GitHub state.
 * @param {{ eventName: string, repository: string, ref: string, token: string, requestJson: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ prNumber: number, sha: string, deploymentId: string, branchName: string, supabaseProjectRef: string, supabaseBranchId: string, databaseMode: 'shared' | 'ephemeral' }>}
 */
export async function verifyPreviewCloudTrust({
  eventName,
  repository,
  ref,
  token,
  requestJson,
  fetchImpl = fetch,
}) {
  requireCondition(eventName === 'workflow_dispatch', 'only workflow_dispatch is allowed');
  requireCondition(repository === GITHUB_REPOSITORY, 'repository is not allowed');
  requireCondition(
    ref === 'refs/heads/integration',
    'workflow must run from refs/heads/integration',
  );
  requireCondition(
    typeof token === 'string' && token.trim().length > 0,
    'read-only GitHub token is required',
  );
  const request = parseInputs(requestJson);

  await verifyPreviewEnvironmentBoundary({ token: token.trim(), fetchImpl });
  const pullRequest = await readPullRequest({
    prNumber: request.prNumber,
    token: token.trim(),
    fetchImpl,
  });
  const branchName = validatePullRequest(pullRequest, request);
  await verifySharedDatabaseChanges({ request, token: token.trim(), fetchImpl });

  // Detect a branch update or PR state change while paginating its file list.
  const latestPullRequest = await readPullRequest({
    prNumber: request.prNumber,
    token: token.trim(),
    fetchImpl,
  });
  requireCondition(
    validatePullRequest(latestPullRequest, request) === branchName,
    'PR changed during trust verification',
  );

  return { ...request, branchName };
}

function validateOutputRequest(request) {
  requireCondition(
    isRecord(request) &&
      Object.keys(request).length === 7 &&
      [
        'prNumber',
        'sha',
        'deploymentId',
        'branchName',
        'supabaseProjectRef',
        'supabaseBranchId',
        'databaseMode',
      ].every((key) => Object.hasOwn(request, key)) &&
      Number.isSafeInteger(request.prNumber) &&
      request.prNumber > 0 &&
      typeof request.sha === 'string' &&
      /^[a-f0-9]{40}$/.test(request.sha) &&
      typeof request.deploymentId === 'string' &&
      /^dpl_[A-Za-z0-9]+$/.test(request.deploymentId) &&
      safeBranchName(request.branchName) &&
      typeof request.supabaseProjectRef === 'string' &&
      PROJECT_REF.test(request.supabaseProjectRef) &&
      typeof request.supabaseBranchId === 'string' &&
      UUID.test(request.supabaseBranchId) &&
      ['shared', 'ephemeral'].includes(request.databaseMode),
    'validated request is invalid',
  );
  requireCondition(
    request.supabaseProjectRef !== SUPABASE_PRODUCTION_PROJECT_REF &&
      (request.databaseMode === 'shared'
        ? request.supabaseProjectRef === SHARED_PREVIEW_REF &&
          request.supabaseBranchId === SHARED_PREVIEW_BRANCH_ID
        : request.supabaseProjectRef !== SHARED_PREVIEW_REF &&
          request.supabaseBranchId !== SHARED_PREVIEW_BRANCH_ID),
    'validated database identity is invalid',
  );
}

/**
 * Persist only the allowlisted, validated request and safe scalar outputs.
 * @param {{ request: object, requestPath: string, githubOutputPath: string, writeFile?: typeof writeFileSync, appendFile?: typeof appendFileSync }} options
 */
export function writeValidatedPreviewCloudRequest({
  request,
  requestPath,
  githubOutputPath,
  writeFile = writeFileSync,
  appendFile = appendFileSync,
}) {
  validateOutputRequest(request);
  requireCondition(
    isAbsolute(requestPath) && isAbsolute(githubOutputPath),
    'output paths must be absolute',
  );
  requireCondition(
    resolve(requestPath) !== resolve(githubOutputPath),
    'output paths must be distinct',
  );
  const safeRequest = {
    prNumber: request.prNumber,
    sha: request.sha,
    deploymentId: request.deploymentId,
    branchName: request.branchName,
    supabaseProjectRef: request.supabaseProjectRef,
    supabaseBranchId: request.supabaseBranchId,
    databaseMode: request.databaseMode,
  };
  const serialized = `${JSON.stringify(safeRequest, null, 2)}\n`;
  writeFile(requestPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  appendFile(githubOutputPath, `sha=${request.sha}\nbranch=${request.branchName}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function isPathWithin(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

/**
 * Restrict CLI writes to the two runner-temp request files used by the workflow.
 * @param {{ runnerTemp: string, outputPath: string, githubOutputPath: string }} options
 */
export function validateRunnerOutputPath({ runnerTemp, outputPath, githubOutputPath }) {
  requireCondition(
    typeof runnerTemp === 'string' &&
      isAbsolute(runnerTemp) &&
      typeof outputPath === 'string' &&
      isAbsolute(outputPath) &&
      isPathWithin(runnerTemp, outputPath) &&
      ['preview-request.json', 'preview-initial-request.json'].includes(
        outputPath.slice(outputPath.lastIndexOf(sep) + 1),
      ) &&
      typeof githubOutputPath === 'string' &&
      isAbsolute(githubOutputPath) &&
      resolve(outputPath) !== resolve(githubOutputPath),
    'runner output locations are invalid',
  );
}

if (isDirectExecution(import.meta.url)) {
  try {
    const outputPath = process.argv[2];
    const runnerTemp = process.env.RUNNER_TEMP;
    requireCondition(process.argv.length === 3, 'runner output locations are invalid');
    validateRunnerOutputPath({
      runnerTemp,
      outputPath,
      githubOutputPath: process.env.GITHUB_OUTPUT,
    });
    const request = await verifyPreviewCloudTrust({
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      token: process.env.GITHUB_TOKEN,
      requestJson: process.env.PREVIEW_REQUEST_JSON,
    });
    writeValidatedPreviewCloudRequest({
      request,
      requestPath: outputPath,
      githubOutputPath: process.env.GITHUB_OUTPUT,
    });
    console.log('Preview Cloud trust gate passed');
  } catch {
    console.error('Preview Cloud trust gate rejected the request');
    process.exitCode = 1;
  }
}
