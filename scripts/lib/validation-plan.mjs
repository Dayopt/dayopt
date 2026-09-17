#!/usr/bin/env node
/** Declarative plan only. Run from the trusted base checkout; never executes PR code. */
import { createHash } from 'node:crypto';
import { ROOT_MIGRATION_PATH, resolveImpact } from '../ci/impact.mjs';
import { resolveProtectedPathGate } from '../ci/protected-path-gate.mjs';

export const PLAN_VERSION = 1;
const sha = /^[a-f0-9]{40}$/;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** @param {string} file */
export function classifyPlanPath(file) {
  const areas = [];
  if (file === 'README.md' || file === 'LICENSE') return ['prose'];
  if (
    /^(AGENTS\.md|CLAUDE\.md|\.agents\/|\.claude\/|\.codex\/|\.husky\/|\.github\/|scripts\/)/.test(
      file,
    )
  )
    areas.push('policy');
  if (/^(docs\/)/.test(file)) areas.push('contract-docs');
  if (/\.mdx$/.test(file)) areas.push('executable-content');
  if (/\.(css|tsx)$/.test(file)) areas.push('ui');
  if (/\/(time|timeblock|calendar)\/|\/features\/.*\/(domain|server)\//.test(file))
    areas.push('behavior');
  if (/\/api\/|\/mcp\/|\/oauth/.test(file)) areas.push('api');
  if (/^supabase\/|\/database\/|\/supabase\/|rls/.test(file)) areas.push('database');
  if (/\/auth\/|\/oauth|\/stripe\/|\/billing\/|billing-|\/webhooks\//.test(file))
    areas.push('auth-billing');
  if (
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|.*config\.[^/]+)$|^\.nvmrc$|^\.npmrc$/.test(
      file,
    )
  )
    areas.push('dependencies');
  if (areas.length === 0) areas.push(/^(apps|packages)\//.test(file) ? 'behavior' : 'unknown');
  return areas;
}

/**
 * Input completeness must be established by the collector, not a PR artifact.
 * @param {{repository:string, prNumber:number|null, headSha:string, baseSha:string,
 * testSha:string, policySha:string, diff:{complete:boolean, files:string[], hash:string},
 * event:string}} input
 * @param {{graph?: Map<string, Set<string>>}} options
 */
export function createValidationPlan(input, options = {}) {
  const files = [...new Set(input.diff.files)].sort();
  const problems = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository)) problems.push('repository identity missing');
  if (
    ![input.headSha, input.baseSha, input.testSha, input.policySha].every((value) =>
      sha.test(value),
    )
  )
    problems.push('revision identity missing');
  if (input.policySha !== input.baseSha) problems.push('policy must come from trusted base');
  if (!input.diff.complete || !/^[a-f0-9]{64}$/.test(input.diff.hash) || files.length === 0)
    problems.push('complete diff unavailable');
  if (
    files.some(
      (file) =>
        !file || file.startsWith('/') || file.split('/').includes('..') || /[\r\n\0]/.test(file),
    )
  )
    problems.push('invalid diff path');
  if (
    input.event !== 'pull_request' ||
    !Number.isSafeInteger(input.prNumber) ||
    Number(input.prNumber) < 1
  )
    problems.push('PR context unavailable');
  const impact = resolveImpact(files, options);
  const protectedPaths = resolveProtectedPathGate(files);
  const areas = [...new Set(files.flatMap(classifyPlanPath))].sort();
  const unknown = areas.includes('unknown') || impact.unknown.length > 0;
  const proseOnly =
    files.length > 0 &&
    files.every((file) => classifyPlanPath(file).every((area) => area === 'prose'));
  const policy = areas.includes('policy');
  const database = areas.includes('database');
  // integration job（fresh）は `supabase/migrations/**` 全体で走る。upgrade / old-consumer job は
  // production に適用される root の migration ファイルだけで起動する（check.mjs と同じ判定）
  const migrations = files.some((file) => file.startsWith('supabase/migrations/'));
  const rootMigrations = files.some((file) => ROOT_MIGRATION_PATH.test(file));
  const indeterminate = problems.length > 0;
  const suite = (required, reason) => ({
    status: indeterminate ? 'indeterminate' : required ? 'required' : 'not-applicable',
    reason: indeterminate
      ? `Unresolved input: ${problems.join('; ')}`
      : required
        ? reason
        : `No matching changes: ${reason}`,
  });
  const required = {
    static: suite(true, 'Every change requires static integrity checks'),
    scripts: suite(!proseOnly, 'Executable code and policy need script contract tests'),
    productUnit: suite(
      impact.productUnit || unknown,
      impact.reasons.productUnit ?? 'Workspace impact',
    ),
    webCi: suite(impact.webCi || unknown, impact.reasons.webCi ?? 'Workspace impact'),
    integration: suite(impact.integration || database || unknown, 'Database and service contracts'),
    mcpConformance: suite(
      impact.mcpConformance || areas.includes('api') || unknown,
      'Public API contract',
    ),
    productPreview: suite(impact.product || unknown, 'Product deployment with isolated database'),
    webPreview: suite(impact.web || unknown, 'Web deployment; database not required'),
    productJourney: suite(
      impact.productJourney || unknown,
      'E2E after product Preview identity is verified',
    ),
    webPreviewSmoke: suite(
      impact.webPreviewSmoke || unknown,
      'Smoke after web deployment identity is verified',
    ),
    dbFresh: suite(migrations || unknown, 'Candidate migration set from empty database'),
    dbUpgrade: suite(
      rootMigrations || unknown,
      'Trusted baseline plus synthetic data upgraded to candidate',
    ),
    oldConsumer: suite(
      rootMigrations || unknown,
      'Live consumer must remain compatible after migration',
    ),
  };
  const reviewRequired = !proseOnly || protectedPaths.required || unknown;
  return {
    schemaVersion: PLAN_VERSION,
    policyVersion: PLAN_VERSION,
    identity: {
      repository: input.repository,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      testSha: input.testSha,
      policySha: input.policySha,
      diffHash: input.diff.hash,
    },
    status: indeterminate ? 'indeterminate' : 'determinate',
    problems,
    files,
    areas,
    required,
    environments: {
      productPreview: impact.product || unknown ? 'isolated-pr-database' : 'not-applicable',
      databaseTests: migrations || unknown ? 'disposable-local' : 'not-applicable',
    },
    review: {
      ...suite(
        reviewRequired,
        proseOnly ? 'Allowlisted prose only' : 'Behavior, policy or external contract changed',
      ),
      focus: reviewRequired ? ['REVIEW-1', 'REVIEW-2', 'REVIEW-3', 'TEST-1'] : [],
      protected: protectedPaths.required || policy,
    },
    authority: {
      code: proseOnly ? 'AUTONOMOUS' : 'CHECKPOINT',
      production: 'EXPLICIT AUTHORITY',
      productionAuthorized: false,
    },
    legacyImpact: impact,
    planId: digest({
      version: PLAN_VERSION,
      input: { ...input, diff: { ...input.diff, files } },
      files,
      required,
    }),
  };
}

export function formatValidationPlan(plan) {
  const lines = [
    '## Validation plan (shadow)',
    '',
    `Plan: \`${plan.planId}\` — **${plan.status}**`,
    `Base/policy: \`${plan.identity.baseSha}\`; head: \`${plan.identity.headSha}\`; tested: \`${plan.identity.testSha}\``,
    `Diff: \`${plan.identity.diffHash}\``,
    '',
    '| Suite | New plan | Reason |',
    '| --- | --- | --- |',
  ];
  for (const [name, rule] of Object.entries(plan.required))
    lines.push(`| ${name} | ${rule.status} | ${rule.reason} |`);
  lines.push(
    '',
    `Review: ${plan.review.status}; ${plan.review.reason}`,
    `Areas: ${plan.areas.join(', ')}`,
    'Shadow only: existing checks and required conditions are unchanged.',
    '',
    '### Legacy comparison',
    '',
    '| Selection | Legacy | New |',
    '| --- | --- | --- |',
  );
  for (const [legacy, next] of [
    ['productUnit', 'productUnit'],
    ['webCi', 'webCi'],
    ['integration', 'integration'],
    ['mcpConformance', 'mcpConformance'],
    ['product', 'productPreview'],
    ['web', 'webPreview'],
  ])
    lines.push(`| ${legacy} | ${plan.legacyImpact[legacy]} | ${plan.required[next].status} |`);
  if (plan.problems.length) lines.push('', ...plan.problems.map((problem) => `- ${problem}`));
  return `${lines.join('\n')}\n`;
}
