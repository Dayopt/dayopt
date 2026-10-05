import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { runCandidateGate } from './release-candidate-gate.mjs';
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

export function requiredChecksGreen({ rules, checks, statuses }) {
  assertCandidateBranchRules(rules);
  const required = rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters.required_status_checks);
  return required.every((requiredCheck) => {
    const matching = checks
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
        ...statuses
          .filter((status) => status.context === requiredCheck.context)
          .map((status) => ({ at: status.created_at, green: status.state === 'success' })),
      );
    const timestamps = matching.map(({ at }) => Date.parse(at));
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) return false;
    matching.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return matching.length > 0 && matching[0].green;
  });
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
    const checks = api(
      `repos/${repository}/commits/${candidate.sha}/check-runs?per_page=100`,
    ).check_runs;
    const statuses = api(
      `repos/${repository}/commits/${candidate.sha}/status?per_page=100`,
    ).statuses;
    if (!requiredChecksGreen({ rules, checks, statuses }))
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
    return result;
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
      body: `<!-- release-candidate:${candidate.runId}:${candidate.attempt} -->\nWriter: Release Candidate publisher.\n\nRefs #3009\n\n全体検証済みの固定候補。SHA: ${candidate.sha}; tree: ${candidate.tree}.\nDB: ${candidate.db.identity}.\nEvidence: ${run.html_url}\n\n既存 checks と Release Candidate Gate の成功を確認して ready 化し、同じ gate を通る publisher merge を実行する。main が前進・候補が stale の場合は全体を再検証する。`,
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
  ready = (number) => {
    execFileSync('gh', ['pr', 'ready', String(number), '--repo', repository], { stdio: 'pipe' });
  },
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 120,
} = {}) {
  const pr = await publish({ mode: 'open', runId, repository });
  if (pr.draft) ready(pr.number);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = api(`repos/${repository}/pulls/${pr.number}`);
    if (current.state !== 'open' || current.head.sha !== pr.head.sha)
      throw new Error('Candidate held: promotion PR closed or changed while waiting');
    const rules = api(`repos/${repository}/rules/branches/main`);
    const checks = api(
      `repos/${repository}/commits/${current.head.sha}/check-runs?per_page=100`,
    ).check_runs;
    const statuses = api(
      `repos/${repository}/commits/${current.head.sha}/status?per_page=100`,
    ).statuses;
    if (requiredChecksGreen({ rules, checks, statuses }))
      return publish({ mode: 'merge', prNumber: String(pr.number), repository });
    if (attempt + 1 < attempts) await sleep(30_000);
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
    console.log(result.html_url ?? `Merged candidate: ${result.sha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate held: publication failed');
    process.exitCode = 1;
  }
}
