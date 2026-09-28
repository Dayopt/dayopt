import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER_STATUSES = new Set([
  'creating',
  'creation-unconfirmed',
  'created',
  'cleanup-failed',
  'deleted',
]);
const RUN_STATUSES = new Set([
  'running',
  'recovering',
  'recovery-failed',
  'passed',
  'failed',
  'recovered',
]);
const TABLES = [
  ['records', 'user_id'],
  ['plans', 'user_id'],
  ['activities', 'user_id'],
  ['categories', 'user_id'],
  ['user_settings', 'user_id'],
  ['profiles', 'id'],
];

export const PREVIEW_RUN_STALE_AFTER_MS = 10 * 60 * 1000;

export function requireTrustedRecoverySource({ headSha, originMainSha, clean }) {
  if (
    !clean ||
    !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(originMainSha ?? '') ||
    headSha !== originMainSha
  ) {
    throw new Error('Preview E2E recovery requires a clean checkout of the current origin/main');
  }
}

export function previewE2EStateRoot(env = process.env, home = homedir()) {
  const configured = env.E2E_PREVIEW_STATE_DIR?.trim();
  if (configured) return resolve(configured);
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state');
  return join(stateHome, 'dayopt', 'preview-e2e');
}

export function ensurePreviewE2EStateRoot(stateRoot) {
  const root = resolve(stateRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Preview E2E state directory must be a private directory');
  }
  return root;
}

function candidateFromReady(ready) {
  return {
    sha: ready.sha,
    deploymentId: ready.deploymentId,
    prNumber: ready.prNumber,
    branchName: ready.branchName,
    databaseMode: ready.databaseMode,
    supabaseProjectRef: ready.supabaseProjectRef,
    supabaseBranchId: ready.supabaseBranchId,
    migrationVersions: [...ready.migrationVersions].sort(),
    origin: ready.origin,
  };
}

export function createPreviewRunManifest({ runId, ready, evidenceDirectory, now = new Date() }) {
  if (!UUID.test(runId ?? '')) throw new Error('Invalid Preview E2E run identity');
  return {
    version: 1,
    runId,
    status: 'running',
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    candidate: candidateFromReady(ready),
    evidenceDirectory,
  };
}

export function writePreviewRunManifest(runDirectory, manifest) {
  const path = join(runDirectory, 'manifest.json');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function readManifest(runDirectory, runId) {
  const directoryMetadata = lstatSync(runDirectory);
  const manifestPath = join(runDirectory, 'manifest.json');
  const manifestMetadata = lstatSync(manifestPath);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    (directoryMetadata.mode & 0o077) !== 0 ||
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    (manifestMetadata.mode & 0o077) !== 0
  ) {
    throw new Error('Preview E2E recovery manifest permissions are invalid');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const candidate = manifest?.candidate;
  if (
    manifest?.version !== 1 ||
    manifest.runId !== runId ||
    !RUN_STATUSES.has(manifest.status) ||
    !Number.isFinite(Date.parse(manifest.heartbeatAt)) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !candidate ||
    !/^[a-f0-9]{40}$/.test(candidate.sha ?? '') ||
    !/^dpl_[A-Za-z0-9]+$/.test(candidate.deploymentId ?? '') ||
    !Number.isSafeInteger(candidate.prNumber) ||
    candidate.prNumber <= 0 ||
    typeof candidate.branchName !== 'string' ||
    !candidate.branchName ||
    !['shared', 'ephemeral'].includes(candidate.databaseMode) ||
    !/^[a-z]{20}$/.test(candidate.supabaseProjectRef ?? '') ||
    candidate.supabaseProjectRef === SUPABASE_PRODUCTION_PROJECT_REF ||
    !UUID.test(candidate.supabaseBranchId ?? '') ||
    !Array.isArray(candidate.migrationVersions) ||
    candidate.migrationVersions.length === 0 ||
    !candidate.migrationVersions.every((version) => /^\d{14}$/.test(version)) ||
    !/^https:\/\/product-[a-z0-9]+-dayopt\.vercel\.app$/.test(candidate.origin ?? '')
  ) {
    throw new Error('Preview E2E recovery manifest is invalid');
  }
  if (resolve(manifest.evidenceDirectory) !== resolve(runDirectory, 'evidence')) {
    throw new Error('Preview E2E recovery evidence path is invalid');
  }
  const evidenceMetadata = lstatSync(manifest.evidenceDirectory);
  if (
    !evidenceMetadata.isDirectory() ||
    evidenceMetadata.isSymbolicLink() ||
    (evidenceMetadata.mode & 0o077) !== 0
  ) {
    throw new Error('Preview E2E recovery evidence permissions are invalid');
  }
  return manifest;
}

function readOwnedUserEvidence(evidenceDirectory, runId) {
  const usersDirectory = join(evidenceDirectory, 'users');
  if (!existsSync(usersDirectory)) return [];
  const usersMetadata = lstatSync(usersDirectory);
  if (
    !usersMetadata.isDirectory() ||
    usersMetadata.isSymbolicLink() ||
    (usersMetadata.mode & 0o077) !== 0
  ) {
    throw new Error('Preview E2E user evidence permissions are invalid');
  }
  const names = readdirSync(usersDirectory).sort();
  const entries = [];
  for (const name of names) {
    const temporaryMatch = /^([a-f0-9-]{36})\.json\.tmp$/.exec(name);
    if (temporaryMatch) {
      const temporaryUserId = temporaryMatch[1];
      const temporaryPath = join(usersDirectory, name);
      const temporaryMetadata = lstatSync(temporaryPath);
      if (
        !UUID.test(temporaryUserId) ||
        !temporaryMetadata.isFile() ||
        temporaryMetadata.isSymbolicLink() ||
        (temporaryMetadata.mode & 0o077) !== 0
      ) {
        throw new Error('Preview E2E user evidence permissions are invalid');
      }
      // The writer records `creating` before making the Auth call. If a first-write
      // temp file remains, Auth creation has not started; a later state rewrite
      // leaves the prior atomic .json record available for recovery.
      rmSync(temporaryPath, { force: true });
      continue;
    }
    const match = /^([a-f0-9-]{36})\.json$/.exec(name);
    if (!match || !UUID.test(match[1])) throw new Error('Preview E2E user evidence is invalid');
    const path = join(usersDirectory, name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Preview E2E user evidence permissions are invalid');
    }
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    if (
      evidence?.runId !== runId ||
      evidence.userId !== match[1] ||
      !USER_STATUSES.has(evidence.status) ||
      !Number.isFinite(Date.parse(evidence.observedAt))
    ) {
      throw new Error('Preview E2E user evidence is invalid');
    }
    entries.push(evidence);
  }
  return entries;
}

function writeUserEvidence(evidenceDirectory, runId, userId, status, now) {
  const usersDirectory = join(evidenceDirectory, 'users');
  mkdirSync(usersDirectory, { recursive: true, mode: 0o700 });
  const path = join(usersDirectory, `${userId}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ runId, userId, status, observedAt: now.toISOString() }),
    { mode: 0o600 },
  );
  renameSync(temporary, path);
}

function sameCandidate(expected, observed) {
  const actual = candidateFromReady(observed);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function isSyntheticCriticalPathEmail(email) {
  return /^(critical-path|mobile-critical-path)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@example\.com$/i.test(
    email ?? '',
  );
}

async function getVerifiedRunUser(admin, evidence, runId) {
  let result;
  try {
    result = await admin.auth.admin.getUserById(evidence.userId);
  } catch {
    throw new Error('Preview E2E recovery could not verify a synthetic user');
  }
  if (result.error) {
    if (result.error.status === 404) return null;
    throw new Error('Preview E2E recovery could not verify a synthetic user');
  }
  const user = result.data?.user;
  if (
    !user ||
    user.id !== evidence.userId ||
    user.app_metadata?.e2e_run_id !== runId ||
    !isSyntheticCriticalPathEmail(user.email)
  ) {
    throw new Error('Preview E2E user ownership does not match the recovery run');
  }
  return user;
}

async function ownedTablesAreEmpty(admin, userId) {
  let hasRows = false;
  for (const [table, column] of TABLES) {
    let verification;
    try {
      verification = await admin
        .from(table)
        .select(column, { count: 'exact', head: true })
        .eq(column, userId);
    } catch {
      throw new Error(`Preview E2E recovery could not verify ${table}`);
    }
    if (verification.error) {
      throw new Error(`Preview E2E recovery could not verify ${table}`);
    }
    if (verification.count !== 0) hasRows = true;
  }
  return !hasRows;
}

async function cleanupOwnedUser(admin, evidence, runId) {
  const user = await getVerifiedRunUser(admin, evidence, runId);
  if (!user) {
    // Never delete app rows without reconfirming Auth ownership. Checking that every
    // owned table is empty makes the final Auth-delete/evidence-write window retryable.
    if (await ownedTablesAreEmpty(admin, evidence.userId)) return;
    throw new Error(
      'Preview E2E Auth ownership marker is missing; manual verification is required',
    );
  }
  for (const [table, column] of TABLES) {
    let result;
    try {
      result = await admin.from(table).delete().eq(column, evidence.userId);
    } catch {
      throw new Error(`Preview E2E recovery could not clean ${table}`);
    }
    if (result.error) throw new Error(`Preview E2E recovery could not clean ${table}`);
    let verification;
    try {
      verification = await admin
        .from(table)
        .select(column, { count: 'exact', head: true })
        .eq(column, evidence.userId);
    } catch {
      throw new Error(`Preview E2E recovery could not verify ${table}`);
    }
    if (verification.error || verification.count !== 0) {
      throw new Error(`Preview E2E recovery could not verify ${table}`);
    }
  }
  let result;
  try {
    result = await admin.auth.admin.deleteUser(evidence.userId, false);
  } catch {
    throw new Error('Preview E2E recovery could not delete the verified synthetic user');
  }
  if (result.error && result.error.status !== 404) {
    throw new Error('Preview E2E recovery could not delete the verified synthetic user');
  }
  const remainingUser = await getVerifiedRunUser(admin, evidence, runId);
  if (remainingUser) {
    throw new Error('Preview E2E recovery could not verify synthetic user deletion');
  }
}

function removePrivateOutput(runDirectory) {
  const privateDirectory = join(runDirectory, 'private');
  if (!existsSync(privateDirectory)) return;
  const privateMetadata = lstatSync(privateDirectory);
  if (
    !privateMetadata.isDirectory() ||
    privateMetadata.isSymbolicLink() ||
    (privateMetadata.mode & 0o077) !== 0
  ) {
    throw new Error('Preview E2E private output permissions are invalid');
  }
  rmSync(privateDirectory, { recursive: true, force: true });
}

export async function recoverPreviewE2ERun({
  runId,
  stateRoot,
  env = process.env,
  observe,
  createAdmin,
  now = () => new Date(),
}) {
  if (!UUID.test(runId ?? '')) throw new Error('A valid Preview E2E run ID is required');
  const root = resolve(stateRoot);
  const runDirectory = join(root, runId);
  if (resolve(runDirectory) !== join(root, runId)) {
    throw new Error('Preview E2E recovery path is invalid');
  }
  ensurePreviewE2EStateRoot(root);
  const manifest = readManifest(runDirectory, runId);
  if (manifest.status === 'recovered') {
    removePrivateOutput(runDirectory);
    return {
      runId,
      status: 'recovered',
      recoveredUserIds: [],
      evidenceDirectory: manifest.evidenceDirectory,
    };
  }
  const heartbeatAge = now().getTime() - Date.parse(manifest.heartbeatAt);
  if (
    ['running', 'recovering'].includes(manifest.status) &&
    heartbeatAge < PREVIEW_RUN_STALE_AFTER_MS
  ) {
    throw new Error('Preview E2E run is still active; recovery is not allowed');
  }
  if (
    !env.SUPABASE_SECRET_KEY?.trim() ||
    !env.GITHUB_TOKEN?.trim() ||
    !env.SUPABASE_PREVIEW_READINESS_TOKEN?.trim() ||
    !env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
  ) {
    throw new Error('Preview E2E recovery requires scoped nonproduction credentials');
  }

  let heartbeat;
  let recovering;
  try {
    const current = manifest;
    recovering = { ...current, status: 'recovering', heartbeatAt: now().toISOString() };
    writePreviewRunManifest(runDirectory, recovering);
    heartbeat = setInterval(() => {
      recovering.heartbeatAt = now().toISOString();
      writePreviewRunManifest(runDirectory, recovering);
    }, 30_000);
    heartbeat.unref?.();

    const observed = await observe({
      sha: current.candidate.sha,
      deploymentId: current.candidate.deploymentId,
      branchName: current.candidate.branchName,
      prNumber: current.candidate.prNumber,
      supabaseProjectRef: current.candidate.supabaseProjectRef,
      supabaseBranchId: current.candidate.supabaseBranchId,
      databaseMode: current.candidate.databaseMode,
      expectedMigrations: current.candidate.migrationVersions,
      githubToken: env.GITHUB_TOKEN,
      supabaseToken: env.SUPABASE_PREVIEW_READINESS_TOKEN,
      bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
      // Recover the already-owned pinned run even after its PR closes or advances.
      requireRunnablePullRequest: false,
    });
    if (!sameCandidate(current.candidate, observed)) {
      throw new Error('Preview E2E recovery target does not match the recorded candidate');
    }
    const evidence = readOwnedUserEvidence(current.evidenceDirectory, runId);
    const activeEvidence = evidence.filter((user) => user.status !== 'deleted');
    if (activeEvidence.length > 20) {
      throw new Error('Preview E2E recovery exceeds the per-run synthetic-user limit');
    }
    const admin = createAdmin(current.candidate.supabaseProjectRef, env.SUPABASE_SECRET_KEY);

    const recoveredUserIds = [];
    for (const user of activeEvidence) {
      await cleanupOwnedUser(admin, user, runId);
      writeUserEvidence(current.evidenceDirectory, runId, user.userId, 'deleted', now());
      recoveredUserIds.push(user.userId);
    }
    clearInterval(heartbeat);
    heartbeat = undefined;
    const completed = {
      ...recovering,
      status: 'recovered',
      heartbeatAt: now().toISOString(),
      completedAt: now().toISOString(),
    };
    writeFileSync(
      join(current.evidenceDirectory, 'recovery.json'),
      JSON.stringify(
        { runId, status: 'recovered', recoveredUserIds, completedAt: completed.completedAt },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    writePreviewRunManifest(runDirectory, completed);
    removePrivateOutput(runDirectory);
    return {
      runId,
      status: 'recovered',
      recoveredUserIds,
      evidenceDirectory: current.evidenceDirectory,
    };
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    try {
      const current = readManifest(runDirectory, runId);
      writePreviewRunManifest(runDirectory, {
        ...current,
        status: 'recovery-failed',
        heartbeatAt: now().toISOString(),
      });
    } catch {
      // Keep the original recovery error safe and actionable.
    }
    if (error instanceof Error && error.message.startsWith('Preview E2E')) throw error;
    throw new Error('Preview E2E recovery failed; retained run evidence for retry');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export function listPreviewRecoveryRuns(stateRoot) {
  const root = resolve(stateRoot);
  if (!existsSync(root)) return [];
  try {
    ensurePreviewE2EStateRoot(root);
  } catch {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
    .flatMap((entry) => {
      const directory = join(root, entry.name);
      try {
        const manifest = readManifest(directory, entry.name);
        return [
          {
            runId: manifest.runId,
            status: manifest.status,
            heartbeatAt: manifest.heartbeatAt,
            databaseMode: manifest.candidate.databaseMode,
            supabaseProjectRef: manifest.candidate.supabaseProjectRef,
            supabaseBranchId: manifest.candidate.supabaseBranchId,
            evidenceDirectory: manifest.evidenceDirectory,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.heartbeatAt.localeCompare(right.heartbeatAt));
}
