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
    return verifyCandidateEvidence({
      evidence,
      run,
      currentMainSha: evidence.candidate.mainSha,
      actualTree: evidence.candidate.tree,
      maxAgeSeconds,
      now,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const candidate = checkCandidateHeartbeat();
    console.log(`Latest candidate evidence is fresh: ${candidate.sha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate heartbeat failed');
    process.exitCode = 1;
  }
}
