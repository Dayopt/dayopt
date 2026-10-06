import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { isTrustedCandidateWorkflowPath, verifyCandidateEvidence } from './release-candidate.mjs';

export function checkCandidateHeartbeat({
  repository = process.env.GITHUB_REPOSITORY,
  maxAgeSeconds = Number(process.env.RELEASE_CANDIDATE_MAX_AGE_SECONDS),
  now = new Date().toISOString(),
  api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })),
  download = (runId, name, dir) => {
    execFileSync(
      'gh',
      ['run', 'download', runId, '--repo', repository, '--name', name, '--dir', dir],
      { stdio: 'pipe' },
    );
  },
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  // Inspect the latest run, including failures and in-progress runs. An older
  // green run cannot hide a missed, delayed or red candidate.
  const run = api(
    `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`,
  ).workflow_runs?.[0];
  if (
    !run ||
    run.repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    !isTrustedCandidateWorkflowPath(run.path) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('Candidate held: latest candidate is missing, unfinished or red');
  const dir = mkdtempSync(join(tmpdir(), 'dayopt-candidate-heartbeat-'));
  try {
    download(String(run.id), `candidate-evidence-${run.run_attempt}`, dir);
    const evidence = JSON.parse(readFileSync(join(dir, 'candidate-evidence.json'), 'utf8'));
    const candidate = evidence?.candidate;
    if (
      !/^[0-9a-f]{40}$/.test(candidate?.sha ?? '') ||
      !/^[0-9a-f]{40}$/.test(candidate?.tree ?? '') ||
      !/^[0-9a-f]{40}$/.test(candidate?.mainSha ?? '')
    )
      throw new Error('Candidate held: candidate snapshot SHAs are invalid');
    const candidateCommit = api(`repos/${repository}/commits/${candidate.sha}`);
    if (
      candidateCommit?.sha !== candidate.sha ||
      candidateCommit?.commit?.tree?.sha !== candidate.tree
    )
      throw new Error('Candidate held: candidate commit tree differs from sealed evidence');
    const currentMainSha = api(`repos/${repository}/git/ref/heads/main`).object?.sha;
    if (!/^[0-9a-f]{40}$/.test(currentMainSha ?? ''))
      throw new Error('Candidate held: current main SHA is unknown');
    let heartbeatStatus = 'fresh';
    if (currentMainSha !== candidate?.mainSha) {
      const currentMainCommit = api(`repos/${repository}/commits/${currentMainSha}`);
      if (
        currentMainCommit?.sha !== currentMainSha ||
        !/^[0-9a-f]{40}$/.test(currentMainCommit?.commit?.tree?.sha ?? '') ||
        currentMainCommit.commit.tree.sha !== candidate?.tree ||
        currentMainCommit.parents?.length !== 2 ||
        currentMainCommit.parents[0]?.sha !== candidate?.mainSha ||
        currentMainCommit.parents[1]?.sha !== candidate?.sha
      )
        throw new Error('Candidate held: main advanced beyond this candidate');
      heartbeatStatus = 'main-merged';
    }
    const verifiedCandidate = verifyCandidateEvidence({
      evidence,
      run,
      // A two-parent merge with the exact baseline, candidate parent and tree proves consumption.
      // In that one case, verify the sealed evidence against its captured baseline.
      currentMainSha: heartbeatStatus === 'main-merged' ? candidate.mainSha : currentMainSha,
      actualTree: candidateCommit.commit.tree.sha,
      maxAgeSeconds,
      now,
    });
    if (api(`repos/${repository}/git/ref/heads/main`).object?.sha !== currentMainSha)
      throw new Error('Candidate held: main changed while heartbeat evidence was checked');
    return { ...verifiedCandidate, heartbeatStatus, reusable: heartbeatStatus === 'fresh' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const candidate = checkCandidateHeartbeat();
    if (candidate.heartbeatStatus === 'main-merged')
      console.log(
        `Latest candidate evidence was consumed by a verified main merge: ${candidate.sha}; Production deployment status is not asserted.`,
      );
    else console.log(`Latest candidate evidence is fresh: ${candidate.sha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate heartbeat failed');
    process.exitCode = 1;
  }
}
