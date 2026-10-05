import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { runCandidateGate } from './release-candidate-gate.mjs';
import { ensureIntegrationMergebackPr } from './release-candidate-mergeback.mjs';
import { isTrustedCandidateWorkflowPath, verifyCandidateEvidence } from './release-candidate.mjs';

export function assertCandidateBranchRules(rules) {
  if (
    !Array.isArray(rules) ||
    !rules.some((rule) => rule.type === 'pull_request') ||
    !rules.some(
      (rule) =>
        rule.type === 'required_status_checks' &&
        rule.parameters?.strict_required_status_checks_policy === true &&
        rule.parameters.required_status_checks?.some(
          (check) => check.context === 'Release Candidate Gate',
        ),
    )
  )
    throw new Error(
      'Candidate held: strict main checks including Release Candidate Gate must be enforced',
    );
}

/** @param {{ rules: any[], checks?: any[], statuses?: any[], headChecks?: any[], headStatuses?: any[] }} input */
export function requiredChecksGreen({
  rules,
  checks = [],
  statuses = [],
  headChecks = [],
  headStatuses = [],
}) {
  assertCandidateBranchRules(rules);
  const required = rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters.required_status_checks);
  return required.every((requiredCheck) => {
    const matchingForCommit = (commitChecks, commitStatuses) => {
      const matching = commitChecks
        .filter(
          (check) =>
            check.name === requiredCheck.context &&
            (!requiredCheck.integration_id || check.app?.id === requiredCheck.integration_id),
        )
        .map((check) => ({
          at: check.started_at ?? check.created_at,
          green:
            check.status === 'completed' &&
            ['success', 'skipped', 'neutral'].includes(check.conclusion),
        }));
      if (!requiredCheck.integration_id)
        matching.push(
          ...commitStatuses
            .filter((status) => status.context === requiredCheck.context)
            .map((status) => ({ at: status.created_at, green: status.state === 'success' })),
        );
      return matching;
    };
    // GitHub Actions pull_request checks are attached to the synthetic merge commit.
    // Providers that report only on the PR head remain valid there as a fallback.
    const matching = matchingForCommit(checks, statuses);
    if (matching.length === 0) matching.push(...matchingForCommit(headChecks, headStatuses));
    const timestamps = matching.map(({ at }) => Date.parse(at));
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) return false;
    matching.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return matching.length > 0 && matching[0].green;
  });
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}`;

export function countUnresolvedReviewThreads({ graphql, repository, number, maxPages = 50 }) {
  const [owner, name] = repository.split('/');
  let after = null;
  let unresolved = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const variables = { owner, name, number };
    if (after) variables.after = after;
    const page = graphql(REVIEW_THREADS_QUERY, variables)?.repository?.pullRequest?.reviewThreads;
    if (
      !page?.pageInfo ||
      typeof page.pageInfo.hasNextPage !== 'boolean' ||
      !Array.isArray(page.nodes) ||
      page.nodes.some((thread) => typeof thread?.isResolved !== 'boolean')
    )
      throw new Error('Candidate held: review thread status is incomplete');
    unresolved += page.nodes.filter((thread) => thread.isResolved === false).length;
    if (page.pageInfo.hasNextPage === false) return unresolved;
    if (typeof page.pageInfo.endCursor !== 'string' || !page.pageInfo.endCursor)
      throw new Error('Candidate held: review thread pagination cursor is missing');
    after = page.pageInfo.endCursor;
  }
  throw new Error('Candidate held: review thread pagination exceeded the page budget');
}

function isTransientProtectedMergeRejection(error) {
  const message = [error?.message, error?.stderr?.toString?.() ?? error?.stderr]
    .filter(Boolean)
    .join('\n');
  const processStatus = Number(error?.status);
  const status = Number(
    error?.response?.status ??
      message.match(/HTTP (\d{3})/)?.[1] ??
      (processStatus >= 400 ? processStatus : undefined),
  );
  return status === 405 && /protected|ruleset|branch protection|merge blocked/i.test(message);
}

function defaultGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  const response = JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
  if (response.errors?.length) throw new Error('Candidate held: GitHub GraphQL query failed');
  return response.data;
}

export async function publishCandidate({
  mode = '',
  runId = '',
  prNumber = '',
  repository = process.env.GITHUB_REPOSITORY,
  maxAgeSeconds = Number(process.env.RELEASE_CANDIDATE_MAX_AGE_SECONDS),
  api = (path, method = 'GET', body) =>
    JSON.parse(
      execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
      }),
    ),
  git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  gate = runCandidateGate,
  graphql = defaultGraphql,
  ready = (number) => {
    execFileSync('gh', ['pr', 'ready', String(number), '--repo', repository], { stdio: 'pipe' });
  },
  mergeback = ensureIntegrationMergebackPr,
  download = (id, name, dir) => {
    execFileSync(
      'gh',
      ['run', 'download', id, '--repo', repository, '--name', name, '--dir', dir],
      { stdio: 'pipe' },
    );
  },
} = {}) {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.RELEASE_CANDIDATE_ENABLED !== 'true'
  )
    throw new Error('Candidate activation on trusted main is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const rules = api(`repos/${repository}/rules/branches/main`);
  assertCandidateBranchRules(rules);
  if (api('user').login === 'github-actions[bot]')
    throw new Error(
      'Candidate held: GITHUB_TOKEN cannot trigger downstream CI/Production workflows',
    );
  if (mode === 'merge') {
    if (!/^[1-9][0-9]*$/.test(prNumber ?? '')) throw new Error('Candidate PR number is required');
    const pr = api(`repos/${repository}/pulls/${prNumber}`);
    if (
      !/^[0-9a-f]{40}$/.test(pr.head?.sha ?? '') ||
      !/^[0-9a-f]{40}$/.test(pr.merge_commit_sha ?? '')
    )
      throw new Error('Candidate held: promotion PR head or synthetic merge SHA is unknown');
    // The merge API respects branch rules; never --admin or bypass. Its head CAS
    // plus strict up-to-date rules closes the main/head race after the gate.
    const candidate = gate({
      mode: 'pr',
      repository,
      sha: pr.merge_commit_sha,
      prNumber,
      maxAgeSeconds,
      api,
      git,
      download,
    });
    const currentPr = api(`repos/${repository}/pulls/${prNumber}`);
    if (
      currentPr.head?.sha !== candidate.sha ||
      currentPr.merge_commit_sha !== pr.merge_commit_sha ||
      currentPr.mergeable !== true ||
      currentPr.mergeable_state !== 'clean'
    )
      throw new Error('Candidate held: promotion PR changed or is not cleanly mergeable');
    if (countUnresolvedReviewThreads({ graphql, repository, number: Number(prNumber) }) !== 0)
      throw new Error('Candidate held: review threads are unresolved');
    const mergeSha = currentPr.merge_commit_sha;
    const mergeChecks = api(
      `repos/${repository}/commits/${mergeSha}/check-runs?per_page=100`,
    ).check_runs;
    const mergeStatuses = api(
      `repos/${repository}/commits/${mergeSha}/status?per_page=100`,
    ).statuses;
    const headChecks = api(
      `repos/${repository}/commits/${candidate.sha}/check-runs?per_page=100`,
    ).check_runs;
    const headStatuses = api(
      `repos/${repository}/commits/${candidate.sha}/status?per_page=100`,
    ).statuses;
    if (
      !requiredChecksGreen({
        rules,
        checks: mergeChecks,
        statuses: mergeStatuses,
        headChecks,
        headStatuses,
      })
    )
      throw new Error('Candidate held: every ordinary required check must be explicitly green');
    const result = api(`repos/${repository}/pulls/${prNumber}/merge`, 'PUT', {
      merge_method: 'merge',
      sha: candidate.sha,
    });
    if (!result.merged) throw new Error('Candidate held: ordinary protected merge did not succeed');
    const commit = api(`repos/${repository}/commits/${result.sha}`);
    if (
      commit.parents?.length !== 2 ||
      commit.parents[0].sha !== candidate.mainSha ||
      commit.parents[1].sha !== candidate.sha ||
      commit.commit.tree.sha !== candidate.tree
    )
      throw new Error('Candidate held: actual merge differs; Production must remain blocked');
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `verified_main_merge_sha=${result.sha}\n`, 'utf8');
    let mergeBack;
    try {
      mergeBack = mergeback({
        repository,
        mergedMainSha: result.sha,
        api,
        git,
        ready,
      });
    } catch {
      throw new Error(
        `Candidate post-merge merge-back failed after verified main merge ${result.sha} (tree ${candidate.tree}); Production deployment status is not asserted. Inspect the Integration merge-back before assuming environments are aligned.`,
      );
    }
    return { ...result, mergeBack };
  }
  if (mode !== 'open' || !/^[1-9][0-9]*$/.test(runId ?? ''))
    throw new Error('Expected candidate open or merge');
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  if (
    run.repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    !isTrustedCandidateWorkflowPath(run.path) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('Candidate held: successful trusted run is required');
  const dir = mkdtempSync(join(tmpdir(), 'dayopt-publish-candidate-'));
  try {
    download(runId, `candidate-evidence-${run.run_attempt}`, dir);
    const evidence = JSON.parse(readFileSync(join(dir, 'candidate-evidence.json'), 'utf8'));
    const currentMainSha = api(`repos/${repository}/git/ref/heads/main`).object.sha;
    git('fetch', 'origin', currentMainSha, evidence.candidate.sha);
    git('merge-base', '--is-ancestor', currentMainSha, evidence.candidate.sha);
    const actualTree = git('rev-parse', `${evidence.candidate.sha}^{tree}`);
    const candidate = verifyCandidateEvidence({
      evidence,
      run,
      currentMainSha,
      actualTree,
      maxAgeSeconds,
    });
    if (
      candidate.runId !== runId ||
      candidate.mainTree !== git('rev-parse', `${currentMainSha}^{tree}`)
    )
      throw new Error('Candidate held: artifact identity differs from repository');
    const branch = `codex/release-candidate-${candidate.runId}-${candidate.attempt}`;
    const refs = api(`repos/${repository}/git/matching-refs/heads/${branch}`);
    const exact = refs.filter((ref) => ref.ref === `refs/heads/${branch}`);
    if (exact.length === 0)
      api(`repos/${repository}/git/refs`, 'POST', {
        ref: `refs/heads/${branch}`,
        sha: candidate.sha,
      });
    else if (exact.length !== 1 || exact[0].object.sha !== candidate.sha)
      throw new Error('Candidate held: pinned branch was modified');
    const owner = repository.split('/')[0];
    const prs = api(
      `repos/${repository}/pulls?state=all&base=main&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    if (prs.length > 1) throw new Error('Candidate held: duplicate promotion PRs');
    if (prs.length === 1) {
      if (prs[0].state !== 'open' || prs[0].head.sha !== candidate.sha)
        throw new Error('Candidate held: promotion PR closed or changed');
      return prs[0];
    }
    return api(`repos/${repository}/pulls`, 'POST', {
      title: `release: 検証済み候補 ${candidate.sha.slice(0, 12)}`,
      head: branch,
      base: 'main',
      draft: true,
      body: `<!-- release-candidate:${candidate.runId}:${candidate.attempt} -->\nWriter: Release Candidate publisher.\n\nRefs #3009\n\n全体検証済みの固定候補。SHA: ${candidate.sha}; tree: ${candidate.tree}.\nMain SHA: ${candidate.mainSha}.\nDB: ${candidate.db.identity}.\nEvidence: ${run.html_url}\n\n既存 checks と Release Candidate Gate の成功を確認して ready 化し、同じ gate を通る publisher merge を実行する。main が前進・候補が stale の場合は全体を再検証する。`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function autoPromoteCandidate({
  runId = '',
  repository = process.env.GITHUB_REPOSITORY,
  publish = publishCandidate,
  api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })),
  graphql = defaultGraphql,
  ready = (number) => {
    execFileSync('gh', ['pr', 'ready', String(number), '--repo', repository], { stdio: 'pipe' });
  },
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 120,
  pollIntervalMs = 30_000,
} = {}) {
  const pr = await publish({ mode: 'open', runId, repository });
  if (pr.draft) ready(pr.number);
  const expectedMainSha = pr.body?.match(/(?:^|\n)Main SHA: ([0-9a-f]{40})(?:\.|\n|$)/)?.[1];
  if (
    pr.base?.ref !== 'main' ||
    !/^[0-9a-f]{40}$/.test(pr.head?.sha ?? '') ||
    !expectedMainSha ||
    pr.base.sha !== expectedMainSha
  )
    throw new Error('Candidate held: promotion PR candidate/main identity is missing or stale');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = api(`repos/${repository}/pulls/${pr.number}`);
    if (
      current.state !== 'open' ||
      current.base?.ref !== 'main' ||
      current.head?.sha !== pr.head.sha
    )
      throw new Error('Candidate held: promotion PR closed or changed while waiting');
    if (!/^[0-9a-f]{40}$/.test(current.base?.sha ?? ''))
      throw new Error('Candidate held: current main base SHA is unknown');
    if (current.base.sha !== expectedMainSha)
      throw new Error('Candidate held: main advanced while candidate promotion was waiting');
    const mergeableState = current.mergeable_state;
    if (current.mergeable === false || mergeableState === 'dirty')
      throw new Error('Candidate held: promotion PR has merge conflicts');
    if (mergeableState === 'behind') throw new Error('Candidate held: promotion PR is behind main');
    if (!['clean', 'blocked', 'unknown', 'unstable', 'has_hooks', 'draft'].includes(mergeableState))
      throw new Error('Candidate held: promotion PR mergeability is unknown');
    const rules = api(`repos/${repository}/rules/branches/main`);
    let checksGreen = false;
    const syntheticSha = current.merge_commit_sha;
    if (/^[0-9a-f]{40}$/.test(syntheticSha ?? '')) {
      const mergeChecks = api(
        `repos/${repository}/commits/${syntheticSha}/check-runs?per_page=100`,
      ).check_runs;
      const mergeStatuses = api(
        `repos/${repository}/commits/${syntheticSha}/status?per_page=100`,
      ).statuses;
      const headChecks = api(
        `repos/${repository}/commits/${current.head.sha}/check-runs?per_page=100`,
      ).check_runs;
      const headStatuses = api(
        `repos/${repository}/commits/${current.head.sha}/status?per_page=100`,
      ).statuses;
      checksGreen = requiredChecksGreen({
        rules,
        checks: mergeChecks,
        statuses: mergeStatuses,
        headChecks,
        headStatuses,
      });
    }
    if (checksGreen && current.mergeable === true && mergeableState === 'clean') {
      const unresolved = countUnresolvedReviewThreads({
        graphql,
        repository,
        number: pr.number,
      });
      if (unresolved === 0) {
        try {
          return await publish({ mode: 'merge', prNumber: String(pr.number), repository });
        } catch (error) {
          if (!isTransientProtectedMergeRejection(error)) throw error;
        }
      }
    }
    if (attempt + 1 < attempts) await sleep(pollIntervalMs);
  }
  throw new Error('Candidate held: required checks did not all pass before the bounded deadline');
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [mode, id] = process.argv.slice(2);
    const result =
      mode === 'auto'
        ? await autoPromoteCandidate({ runId: id })
        : await publishCandidate({ mode, runId: id, prNumber: id });
    console.log(
      result.html_url ??
        `Merged candidate: ${result.sha}; integration merge-back ${result.mergeBack?.status ?? 'not reported'}${result.mergeBack?.prUrl ? `: ${result.mergeBack.prUrl}` : ''}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate held: publication failed');
    process.exitCode = 1;
  }
}
