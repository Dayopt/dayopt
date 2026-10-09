import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { validateCloudRequest } from '../lib/preview-cloud-binding.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SEED = '00000000-0000-0000-0000-000000000001';
const WORKFLOW = '.github/workflows/ci.yml';
const REPOSITORY = 'Dayopt/dayopt';
const REF = 'refs/heads/main';
const KEYS = [
  'schemaVersion',
  'repository',
  'workflow',
  'workflowRef',
  'workflowSha',
  'sourceRunId',
  'sourceAttempt',
  'runId',
  'createdAt',
  'userIds',
  'request',
];
function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === [...keys].sort()[i]);
}

/** A public, immutable plan saved before candidate checkout and any fixture mutation. */
export function validateCloudIntent(intent) {
  if (
    !exactKeys(intent, KEYS) ||
    intent.schemaVersion !== 1 ||
    intent.repository !== REPOSITORY ||
    intent.workflow !== WORKFLOW ||
    intent.workflowRef !== REF ||
    !/^[a-f0-9]{40}$/.test(intent.workflowSha ?? '') ||
    !Number.isSafeInteger(intent.sourceRunId) ||
    intent.sourceRunId < 1 ||
    !Number.isSafeInteger(intent.sourceAttempt) ||
    intent.sourceAttempt < 1 ||
    typeof intent.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(intent.createdAt) ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    !exactKeys(intent.userIds, ['desktop', 'mobile'])
  )
    throw new Error('Invalid Cloud Preview intent');
  const ids = [intent.runId, intent.userIds.desktop, intent.userIds.mobile];
  if (
    ids.some((id) => typeof id !== 'string' || !UUID.test(id) || id === SEED) ||
    new Set(ids).size !== 3
  )
    throw new Error('Invalid Cloud Preview intent identities');
  if (
    ids.includes('00000000-0000-0000-0000-000000000000') ||
    new Date(intent.createdAt).toISOString() !== intent.createdAt
  )
    throw new Error('Invalid Cloud Preview intent identities or timestamp');
  const request = validateCloudRequest(intent.request);
  if (!exactKeys(intent.request, Object.keys(request)))
    throw new Error('Invalid Cloud Preview intent request');
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowRef: REF,
    workflowSha: intent.workflowSha,
    sourceRunId: intent.sourceRunId,
    sourceAttempt: intent.sourceAttempt,
    runId: intent.runId,
    createdAt: intent.createdAt,
    userIds: { desktop: intent.userIds.desktop, mobile: intent.userIds.mobile },
    request,
  };
}

export function createCloudIntent({
  request,
  env = process.env,
  uuid = randomUUID,
  now = () => new Date(),
}) {
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== REF ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@${REF}` ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw new Error('Cloud Preview intent requires the trusted dispatched workflow');
  return validateCloudIntent({
    schemaVersion: 1,
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowRef: REF,
    workflowSha: env.GITHUB_SHA,
    sourceRunId: Number(env.GITHUB_RUN_ID),
    sourceAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runId: uuid(),
    createdAt: now().toISOString(),
    userIds: { desktop: uuid(), mobile: uuid() },
    request: validateCloudRequest(request),
  });
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [requestPath, destination, ...rest] = process.argv.slice(2);
    const root = resolve(process.env.RUNNER_TEMP ?? '');
    if (
      rest.length ||
      !requestPath ||
      !destination ||
      !process.env.RUNNER_TEMP ||
      resolve(requestPath) !== join(root, 'preview-initial-request.json') ||
      resolve(destination) !== join(root, 'preview-intent')
    )
      throw new Error();
    const stat = lstatSync(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error();
    const intent = createCloudIntent({ request: JSON.parse(readFileSync(requestPath, 'utf8')) });
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    writeFileSync(join(destination, 'intent.json'), JSON.stringify(intent, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log('Cloud Preview intent prepared');
  } catch {
    console.error('Cloud Preview intent could not be prepared');
    process.exitCode = 1;
  }
}
