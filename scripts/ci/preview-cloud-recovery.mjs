import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { decodePreviewArtifactZip } from '../lib/preview-artifact-zip.mjs';
import { verifyPreviewRecoveryTrust } from '../lib/preview-cloud-recovery-trust.mjs';
import { recoverPreviewUsers } from '../runbook/preview-cleanup.mjs';
import { validateCloudIntent } from './preview-cloud-intent.mjs';
import { assertCloudFixtureKey } from './preview-cloud-run.mjs';

const REPO = 'Dayopt/dayopt';
const MAX_ARCHIVE_BYTES = 128 * 1024;
function number(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error();
  return result;
}
function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function safeGhEnv(token, env = process.env) {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'LANG'].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
    ),
    GH_TOKEN: token,
    GH_HOST: 'github.com',
  };
}
async function downloadIntent({ artifactId, token }) {
  if (!Number.isSafeInteger(artifactId) || artifactId < 1 || !token?.trim()) throw new Error();
  try {
    return execFileSync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `repos/${REPO}/actions/artifacts/${artifactId}/zip`,
      ],
      {
        env: safeGhEnv(token),
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_ARCHIVE_BYTES,
      },
    );
  } catch {
    throw new Error('Preview recovery artifact download failed');
  }
}

/** Preserve the recovery-only intent contract; larger handoff envelopes are never accepted here. */
export function decodePreviewIntentArtifactZip(archive) {
  return decodePreviewArtifactZip(archive, 'intent');
}

/** Download only the small, uniquely named public plan; no platform key is needed. */
export async function prepareCloudRecovery({
  directory,
  sourceRunId,
  sourceAttempt,
  env = process.env,
  fetchImpl = fetch,
  download = downloadIntent,
  decode = decodePreviewIntentArtifactZip,
  verify = verifyPreviewRecoveryTrust,
}) {
  const runId = number(sourceRunId);
  const attempt = number(sourceAttempt);
  if (
    env.GITHUB_REPOSITORY !== REPO ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/integration' ||
    env.GITHUB_WORKFLOW_REF !== `${REPO}/.github/workflows/ci.yml@refs/heads/integration` ||
    !env.GITHUB_TOKEN?.trim()
  )
    throw new Error();
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw new Error();
  const data = await response.json();
  if (
    !Array.isArray(data.artifacts) ||
    data.total_count !== data.artifacts.length ||
    data.artifacts.length > 100
  )
    throw new Error();
  const artifacts = data.artifacts.filter(
    (row) => row.name === `preview-intent-${runId}-${attempt}`,
  );
  if (
    artifacts.length !== 1 ||
    artifacts[0].expired !== false ||
    !Number.isSafeInteger(artifacts[0].id) ||
    !Number.isSafeInteger(artifacts[0].size_in_bytes) ||
    artifacts[0].size_in_bytes < 1 ||
    artifacts[0].size_in_bytes > 128 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifacts[0].digest ?? '')
  )
    throw new Error();
  const archive = await download({ artifactId: artifacts[0].id, token: env.GITHUB_TOKEN });
  if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES)
    throw new Error('Preview recovery artifact archive size is invalid');
  const archiveDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (archiveDigest !== artifacts[0].digest)
    throw new Error('Preview recovery artifact digest differs');
  let intent;
  try {
    intent = validateCloudIntent(JSON.parse(decode(archive)));
  } catch {
    throw new Error('Preview recovery intent is invalid');
  }
  const verified = await verify({
    repository: REPO,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    token: env.GITHUB_TOKEN,
    sourceRunId: String(runId),
    sourceAttempt: String(attempt),
    intent,
    fetchImpl,
  });
  if (verified.artifactId !== artifacts[0].id || verified.digest !== artifacts[0].digest)
    throw new Error();
  const result = {
    intent,
    artifactId: verified.artifactId,
    digest: verified.digest,
    ...(verified.recoveryMode === 'broker' ? { recoveryMode: 'broker' } : {}),
  };
  mkdirSync(directory, { mode: 0o700, recursive: false });
  writeFileSync(join(directory, 'verified.json'), JSON.stringify(result), {
    mode: 0o600,
    flag: 'wx',
  });
  return result;
}

/** Stop before the credential-bearing recovery job. UNKNOWN evidence is safe to
 * persist even when provider/Auth termination cannot be established. */
export function admitLegacyRecovery(directory) {
  const saved = readJson(join(directory, 'verified.json'));
  if (saved.recoveryMode === undefined) return;
  if (saved.recoveryMode !== 'broker') throw new Error();
  const intent = validateCloudIntent(saved.intent);
  writeFileSync(
    join(directory, 'recovery.json'),
    JSON.stringify({
      sourceRunId: intent.sourceRunId,
      sourceAttempt: intent.sourceAttempt,
      runId: intent.runId,
      request: intent.request,
      status: 'unknown',
      cleanupConfirmed: false,
      failure: 'fixture-termination-unverified',
      users: [],
    }),
    { mode: 0o600, flag: 'wx' },
  );
  throw new Error('Prepared fixture recovery remains UNKNOWN');
}

/** Reuse exact-ID recovery without enumerating or exposing other Auth users. */
export async function recoverCloudIntent({
  intent,
  directory,
  serviceKey,
  authenticate = assertCloudFixtureKey,
  recover = recoverPreviewUsers,
}) {
  const plan = validateCloudIntent(intent);
  await authenticate({ request: plan.request, serviceKey });
  const journal = mkdtempSync(join(directory, 'owned-'));
  mkdirSync(join(journal, 'users'), { mode: 0o700 });
  try {
    for (const userId of Object.values(plan.userIds)) {
      writeFileSync(
        join(journal, 'users', `${userId}.json`),
        JSON.stringify({ runId: plan.runId, userId, status: 'creation-unconfirmed' }),
        { mode: 0o600, flag: 'wx' },
      );
    }
    const result = await recover({
      evidenceDirectory: journal,
      runId: plan.runId,
      supabaseProjectRef: plan.request.supabaseProjectRef,
      serviceKey,
    });
    const users = Object.values(plan.userIds).map((userId) => {
      const row = readJson(join(journal, 'users', `${userId}.json`));
      if (
        row.runId !== plan.runId ||
        row.userId !== userId ||
        !['deleted', 'cleanup-failed'].includes(row.status)
      )
        throw new Error();
      return { userId, status: row.status };
    });
    if (
      !Number.isSafeInteger(result.checked) ||
      result.checked !== 2 ||
      !Number.isSafeInteger(result.recovered) ||
      result.recovered < 0 ||
      result.recovered > 2
    )
      throw new Error();
    return {
      status:
        result.status === 'clean' && users.every((user) => user.status === 'deleted')
          ? 'clean'
          : 'failed',
      checked: 2,
      recovered: result.recovered,
      users,
    };
  } finally {
    rmSync(journal, { recursive: true, force: true });
  }
}

export async function executeCloudRecovery({
  directory,
  env = process.env,
  verify = verifyPreviewRecoveryTrust,
  recover = recoverCloudIntent,
}) {
  const saved = readJson(join(directory, 'verified.json'));
  const intent = validateCloudIntent(saved.intent);
  const result = {
    sourceRunId: intent.sourceRunId,
    sourceAttempt: intent.sourceAttempt,
    runId: intent.runId,
    request: intent.request,
    observedAt: new Date().toISOString(),
    status: 'failed',
    cleanupConfirmed: false,
    users: [],
  };
  try {
    const current = await verify({
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      token: env.GITHUB_TOKEN,
      sourceRunId: String(intent.sourceRunId),
      sourceAttempt: String(intent.sourceAttempt),
      intent,
    });
    if (current.artifactId !== saved.artifactId || current.digest !== saved.digest)
      throw new Error();
    if (current.recoveryMode !== saved.recoveryMode) throw new Error();
    if (current.recoveryMode === 'broker') {
      // Never route a durable/UNKNOWN fixture into the legacy delete-and-count
      // recovery. The provider terminal / in-flight Auth fence is not proven.
      result.status = 'unknown';
      result.failure = 'fixture-termination-unverified';
      throw new Error();
    }
    const cleanup = await recover({ intent, directory, serviceKey: env.SUPABASE_SECRET_KEY });
    result.status = cleanup.status;
    result.cleanupConfirmed = cleanup.status === 'clean';
    result.users = cleanup.users;
  } catch {
    /* Public failure contains neither provider errors nor private values. */
  }
  writeFileSync(join(directory, 'recovery.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  return result;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [operation, directory, ...rest] = process.argv.slice(2);
    if (
      rest.length ||
      !['prepare', 'execute', 'admit-legacy'].includes(operation) ||
      !process.env.RUNNER_TEMP ||
      resolve(directory ?? '') !== join(resolve(process.env.RUNNER_TEMP), 'preview-recovery')
    )
      throw new Error();
    if (operation === 'admit-legacy') {
      admitLegacyRecovery(directory);
    } else if (operation === 'prepare') {
      await prepareCloudRecovery({
        directory,
        sourceRunId: process.env.PREVIEW_RECOVER_RUN,
        sourceAttempt: process.env.PREVIEW_RECOVER_ATTEMPT,
      });
      console.log('Cloud Preview recovery binding prepared');
    } else {
      const result = await executeCloudRecovery({ directory });
      console.log(
        JSON.stringify({
          sourceRunId: result.sourceRunId,
          sourceAttempt: result.sourceAttempt,
          status: result.status,
        }),
      );
      if (!result.cleanupConfirmed) process.exitCode = 1;
    }
  } catch {
    console.error(
      'Cloud Preview recovery failed; inspect source binding and selected nonproduction credentials',
    );
    process.exitCode = 1;
  }
}
