import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { SUPABASE_PRODUCTION_PROJECT_REF } from './production-auth-config-audit.mjs';
import { expectedMigrationVersions } from './production-migration-readiness.mjs';

class PreviewReadinessError extends Error {}

const PRODUCT_PROJECT_ID = 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa';
const REF = /^[a-z]{20}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIGRATION = /^\d{14}$/;

/** No mutation, redirects, API bodies, or credentials in diagnostics/evidence. */
async function readJson(url, token, fetchImpl, body) {
  try {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new PreviewReadinessError('Preview readiness: platform observation failed');
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new PreviewReadinessError(`Preview readiness: ${message}`);
}

/**
 * Observe a pinned Product Preview and its explicitly selected DB. This is an
 * E2E precondition, not a merge decision or an atomic snapshot. The caller must
 * obtain expected migrations from the same clean source SHA as the deployment.
 * Recheck after the run to detect shared-DB changes during the observation window.
 */
export async function observePreviewReadiness({
  sha,
  deploymentId,
  branchName,
  prNumber,
  supabaseProjectRef,
  supabaseBranchId,
  databaseMode,
  expectedMigrations,
  vercelToken,
  supabaseToken,
  bypassSecret,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  requireCondition(
    /^[a-f0-9]{40}$/.test(sha ?? '') &&
      /^dpl_[a-zA-Z0-9]+$/.test(deploymentId ?? '') &&
      typeof branchName === 'string' &&
      branchName.length > 0 &&
      branchName !== 'main' &&
      Number.isSafeInteger(prNumber) &&
      prNumber > 0,
    'invalid revision or PR identity',
  );
  requireCondition(
    REF.test(supabaseProjectRef ?? '') &&
      supabaseProjectRef !== SUPABASE_PRODUCTION_PROJECT_REF &&
      UUID.test(supabaseBranchId ?? '') &&
      ['shared', 'ephemeral'].includes(databaseMode),
    'invalid nonproduction database identity',
  );
  requireCondition(
    Array.isArray(expectedMigrations) &&
      expectedMigrations.length > 0 &&
      expectedMigrations.every(
        (version) => typeof version === 'string' && MIGRATION.test(version),
      ) &&
      new Set(expectedMigrations).size === expectedMigrations.length,
    'invalid expected migration set',
  );
  requireCondition(
    [vercelToken, supabaseToken, bypassSecret].every(
      (value) => typeof value === 'string' && value.trim(),
    ),
    'platform read credentials and automation bypass are required',
  );

  const startedAt = now().toISOString();
  const deployment = await readJson(
    `https://api.vercel.com/v13/deployments/${deploymentId}`,
    vercelToken,
    fetchImpl,
  );
  requireCondition(
    deployment?.id === deploymentId &&
      deployment.projectId === PRODUCT_PROJECT_ID &&
      (deployment.target === null || deployment.target === 'preview') &&
      deployment.readyState === 'READY' &&
      deployment.meta?.githubCommitSha === sha &&
      deployment.meta?.githubCommitOrg === 'Dayopt' &&
      deployment.meta?.githubCommitRepo === 'dayopt' &&
      deployment.meta?.githubCommitRef === branchName &&
      /^product-[a-z0-9]+-dayopt\.vercel\.app$/.test(deployment.url ?? ''),
    'deployment does not match the ready Product Preview candidate',
  );
  const origin = `https://${deployment.url}`;
  const branches = await readJson(
    `https://api.supabase.com/v1/projects/${SUPABASE_PRODUCTION_PROJECT_REF}/branches`,
    supabaseToken,
    fetchImpl,
  );
  requireCondition(Array.isArray(branches), 'branch inventory is unavailable');
  const matches = branches.filter((branch) => branch.id === supabaseBranchId);
  const branch = matches[0];
  requireCondition(
    matches.length === 1 &&
      branch.project_ref === supabaseProjectRef &&
      branch.parent_project_ref === SUPABASE_PRODUCTION_PROJECT_REF &&
      branch.is_default === false &&
      branch.with_data === false &&
      branch.status === 'FUNCTIONS_DEPLOYED' &&
      (databaseMode === 'shared'
        ? branch.persistent === true
        : branch.persistent === false &&
          branch.git_branch === branchName &&
          branch.pr_number === prNumber),
    'database branch is not the requested ready nonproduction environment',
  );
  const migrations = await readJson(
    `https://api.supabase.com/v1/projects/${supabaseProjectRef}/database/query`,
    supabaseToken,
    fetchImpl,
    {
      query: 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
      read_only: true,
    },
  );
  requireCondition(
    Array.isArray(migrations) &&
      migrations.every((row) => typeof row?.version === 'string' && MIGRATION.test(row.version)),
    'migration observation is invalid',
  );
  const observedMigrations = migrations.map((row) => row.version).sort();
  const expected = [...expectedMigrations].sort();
  requireCondition(
    JSON.stringify(observedMigrations) === JSON.stringify(expected),
    'migration sets differ',
  );

  // The bypass is scoped to this pinned origin, never a browser-wide header.
  const appFetch = (url, options) =>
    fetchImpl(url, {
      ...options,
      headers: { 'x-vercel-protection-bypass': bypassSecret },
    });
  const version = await readJson(`${origin}/api/health/version`, null, appFetch);
  requireCondition(
    version?.preview?.deploymentId === deploymentId &&
      version.preview.sha === sha &&
      version.preview.supabaseProjectRef === supabaseProjectRef,
    'application deployment or database identity differs',
  );
  const health = await readJson(`${origin}/api/health`, null, appFetch);
  requireCondition(
    health?.status === 'healthy' &&
      health.environment === 'preview' &&
      health.checks?.database === 'ok',
    'application health is not ready',
  );
  return {
    status: 'ready',
    sha,
    deploymentId,
    origin,
    prNumber,
    branchName,
    databaseMode,
    supabaseProjectRef,
    supabaseBranchId,
    migrationVersions: expected,
    startedAt,
    observedAt: now().toISOString(),
  };
}

/** CLI input is identifiers only. Credentials are inherited from scoped CI env. */
export function parsePreviewReadinessArgs(args) {
  const keys = new Map([
    ['--sha', 'sha'],
    ['--deployment', 'deploymentId'],
    ['--branch', 'branchName'],
    ['--pr', 'prNumber'],
    ['--db-ref', 'supabaseProjectRef'],
    ['--db-branch', 'supabaseBranchId'],
    ['--db-mode', 'databaseMode'],
  ]);
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys.get(args[index]);
    const value = args[index + 1];
    requireCondition(
      key && value && !value.startsWith('--') && !(key in parsed),
      'invalid command arguments',
    );
    parsed[key] = key === 'prNumber' ? (/^[1-9]\d*$/.test(value) ? Number(value) : NaN) : value;
  }
  requireCondition(
    Object.keys(parsed).length === keys.size,
    'all candidate identifiers must be explicit',
  );
  return parsed;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const input = parsePreviewReadinessArgs(process.argv.slice(2));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    requireCondition(
      git(['rev-parse', 'HEAD']) === input.sha,
      'checkout SHA differs from candidate',
    );
    requireCondition(
      git(['status', '--porcelain', '--untracked-files=normal']) === '',
      'checkout must be clean',
    );
    const result = await observePreviewReadiness({
      ...input,
      expectedMigrations: expectedMigrationVersions(root),
      vercelToken: process.env.VERCEL_TOKEN,
      supabaseToken: process.env.SUPABASE_PREVIEW_READINESS_TOKEN,
      bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      error instanceof PreviewReadinessError
        ? error.message
        : 'Preview readiness could not be evaluated',
    );
    process.exitCode = 1;
  }
}
