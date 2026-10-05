import { execFileSync } from 'node:child_process';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const shaPattern = /^[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Merge-back held: ${message}`);
}

const ghApi =
  (repository) =>
  (path, method = 'GET', body) =>
    JSON.parse(
      execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
      }),
    );

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const readyPullRequest = (number, repository) => {
  execFileSync('gh', ['pr', 'ready', String(number), '--repo', repository], { stdio: 'pipe' });
};

function assertPullRequestIdentity(pr, { repository, mainSha, integrationSha }) {
  requireValue(
    pr?.state === 'open' &&
      Number.isSafeInteger(pr.number) &&
      pr.number > 0 &&
      pr.base?.repo?.full_name === repository &&
      pr.base?.ref === 'integration' &&
      shaPattern.test(pr.base?.sha ?? '') &&
      (integrationSha === undefined || pr.base.sha === integrationSha) &&
      pr.head?.repo?.full_name === repository &&
      pr.head?.ref === 'main' &&
      pr.head?.sha === mainSha &&
      typeof pr.html_url === 'string',
    'open PR must target integration from the exact current main SHA',
  );
}

/**
 * Ensure the verified Production main merge has an ordinary PR path back to integration.
 * This function never merges, updates refs, or bypasses branch protection.
 */
export function ensureIntegrationMergebackPr({
  repository = process.env.GITHUB_REPOSITORY,
  mergedMainSha,
  api,
  git: gitImpl = git,
  ready = (number) => readyPullRequest(number, repository),
} = {}) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'invalid repository');
  requireValue(shaPattern.test(mergedMainSha ?? ''), 'verified main merge SHA is required');
  const request = api ?? ghApi(repository);
  const mainSha = request(`repos/${repository}/git/ref/heads/main`).object.sha;
  const integrationSha = request(`repos/${repository}/git/ref/heads/integration`).object.sha;
  requireValue(
    shaPattern.test(mainSha) && shaPattern.test(integrationSha),
    'branch SHA is invalid',
  );

  gitImpl('fetch', 'origin', mainSha, integrationSha, mergedMainSha);
  requireAncestor(
    gitImpl,
    mergedMainSha,
    mainSha,
    'verified Production merge is no longer in main',
  );
  if (isAncestor(gitImpl, mainSha, integrationSha))
    return { status: 'synced', mainSha, integrationSha, prUrl: null };

  const [owner] = repository.split('/');
  const head = `${owner}:main`;
  const path = `repos/${repository}/pulls?state=all&base=integration&head=${encodeURIComponent(head)}&per_page=100`;
  const matches = request(path);
  requireValue(Array.isArray(matches), 'GitHub PR lookup did not return a list');

  const open = matches.filter((pr) => pr.state === 'open');
  requireValue(open.length <= 1, 'multiple open merge-back PRs exist');
  requireValue(
    !matches.some(
      (pr) =>
        pr.state === 'closed' &&
        !pr.merged_at &&
        pr.head?.ref === 'main' &&
        pr.head?.sha === mainSha &&
        pr.base?.ref === 'integration',
    ),
    'the current main-to-integration PR was closed without merging',
  );
  let pr = open[0];
  if (!pr) {
    pr = request(`repos/${repository}/pulls`, 'POST', {
      title: 'chore(release): merge Production main back into integration',
      head,
      base: 'integration',
      draft: true,
      body: [
        '<!-- release-candidate-mergeback -->',
        'Writer: Release Candidate controller.',
        '',
        'Refs #3009',
        '',
        `Production main merge ${mergedMainSha} is not yet an ancestor of integration ${integrationSha}.`,
        `Current main head: ${mainSha}.`,
        '',
        'Run ordinary Integration CI, review, and the protected merge path. Do not update integration directly or bypass its ruleset.',
      ].join('\n'),
    });
  }
  assertPullRequestIdentity(pr, { repository, mainSha });

  // Detect branch advances during PR lookup/creation. Advancing integration is
  // preserved as the PR base; rewritten or stale heads hold before readying it.
  const latestMainSha = request(`repos/${repository}/git/ref/heads/main`).object.sha;
  const latestIntegrationSha = request(`repos/${repository}/git/ref/heads/integration`).object.sha;
  requireValue(
    shaPattern.test(latestMainSha) && shaPattern.test(latestIntegrationSha),
    'branch SHA is invalid',
  );
  gitImpl('fetch', 'origin', latestMainSha, latestIntegrationSha);
  requireAncestor(gitImpl, mainSha, latestMainSha, 'main changed non-forward while opening the PR');
  requireAncestor(
    gitImpl,
    integrationSha,
    latestIntegrationSha,
    'integration changed non-forward while opening the PR',
  );
  requireAncestor(
    gitImpl,
    mergedMainSha,
    latestMainSha,
    'verified Production merge is no longer in main',
  );
  if (isAncestor(gitImpl, latestMainSha, latestIntegrationSha))
    return {
      status: 'synced',
      mainSha: latestMainSha,
      integrationSha: latestIntegrationSha,
      prUrl: pr.html_url,
    };

  // Re-read the PR after branch refs to ensure its synthetic merge uses both
  // current tips before allowing the normal review/CI flow to start.
  pr = request(`repos/${repository}/pulls/${pr.number}`);
  assertPullRequestIdentity(pr, {
    repository,
    mainSha: latestMainSha,
    integrationSha: latestIntegrationSha,
  });
  if (pr.draft) ready(pr.number);
  return {
    status: 'pending',
    mainSha: latestMainSha,
    integrationSha: latestIntegrationSha,
    prNumber: pr.number,
    prUrl: pr.html_url,
    draft: false,
  };
}

function isAncestor(gitImpl, ancestor, descendant) {
  try {
    gitImpl('merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function requireAncestor(gitImpl, ancestor, descendant, message) {
  if (!isAncestor(gitImpl, ancestor, descendant)) throw new Error(`Merge-back held: ${message}`);
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = ensureIntegrationMergebackPr({ mergedMainSha: process.argv[2] });
    console.log(
      result.status === 'synced'
        ? `Integration already contains main ${result.mainSha}`
        : `Merge-back PR pending: ${result.prUrl}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Merge-back held: unknown error');
    process.exitCode = 1;
  }
}
