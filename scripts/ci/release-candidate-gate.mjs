import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { verifyCandidateEvidence } from './release-candidate.mjs';

export function candidateReference(body) {
  const markers = [
    ...(body ?? '').matchAll(/<!-- release-candidate:([1-9][0-9]*):([1-9][0-9]*) -->/g),
  ];
  if (markers.length !== 1)
    throw new Error('Candidate held: exactly one candidate reference is required');
  return { runId: markers[0][1], attempt: markers[0][2] };
}

export function validatePromotionPr({ pr, repository, reference, candidate, merged = false }) {
  if (
    pr.base?.ref !== 'main' ||
    pr.head?.repo?.full_name !== repository ||
    pr.base?.repo?.full_name !== repository ||
    pr.head?.ref !== `codex/release-candidate-${reference.runId}-${reference.attempt}` ||
    pr.head?.sha !== candidate.sha ||
    pr.draft ||
    (merged ? !pr.merged : pr.state !== 'open' || pr.base.sha !== candidate.mainSha)
  )
    throw new Error('Candidate held: promotion PR identity/base/head differs');
}

export function runCandidateGate({
  mode,
  repository = process.env.GITHUB_REPOSITORY,
  sha = process.env.GITHUB_SHA,
  prNumber = process.env.CANDIDATE_PR_NUMBER,
  maxAgeSeconds = Number(process.env.RELEASE_CANDIDATE_MAX_AGE_SECONDS),
  api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })),
  git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  download = (runId, name, dir) => {
    execFileSync(
      'gh',
      ['run', 'download', runId, '--repo', repository, '--name', name, '--dir', dir],
      { stdio: 'pipe' },
    );
  },
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const mainSha = api(`repos/${repository}/git/ref/heads/main`).object.sha;
  let pr;
  let currentMainSha;
  let actualTree;
  if (mode === 'pr') {
    if (!/^[1-9][0-9]*$/.test(prNumber ?? '')) throw new Error('Candidate PR is required');
    pr = api(`repos/${repository}/pulls/${prNumber}`);
    currentMainSha = mainSha;
    const merge = api(`repos/${repository}/commits/${sha}`);
    if (
      merge.parents.length !== 2 ||
      merge.parents[0].sha !== mainSha ||
      merge.parents[1].sha !== pr.head.sha
    )
      throw new Error('Candidate held: synthetic merge is stale or differs from PR');
    actualTree = merge.commit.tree.sha;
  } else if (mode === 'production') {
    if (mainSha !== sha) throw new Error('Candidate held: main advanced before Production gate');
    const commit = api(`repos/${repository}/commits/${sha}`);
    if (commit.parents.length !== 2)
      throw new Error('Candidate held: a two-parent merge commit is required');
    const associated = api(`repos/${repository}/commits/${sha}/pulls`);
    const matching = associated.filter(
      (item) => item.merged_at && item.merge_commit_sha === sha && item.base.ref === 'main',
    );
    if (matching.length !== 1) throw new Error('Candidate held: merged promotion PR is ambiguous');
    pr = api(`repos/${repository}/pulls/${matching[0].number}`);
    if (commit.parents[1].sha !== pr.head.sha)
      throw new Error('Candidate held: merge parent differs from candidate');
    currentMainSha = commit.parents[0].sha;
    actualTree = commit.commit.tree.sha;
  } else throw new Error('Expected pr or production gate');
  const reference = candidateReference(pr.body);
  const run = api(`repos/${repository}/actions/runs/${reference.runId}`);
  if (
    run.repository?.full_name !== repository ||
    String(run.run_attempt) !== reference.attempt ||
    run.path !== '.github/workflows/release-candidate.yml' ||
    run.head_branch !== 'main' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('Candidate held: trusted successful latest attempt is required');
  const dir = mkdtempSync(join(tmpdir(), 'dayopt-candidate-'));
  try {
    download(reference.runId, `candidate-evidence-${reference.attempt}`, dir);
    const evidence = JSON.parse(readFileSync(join(dir, 'candidate-evidence.json'), 'utf8'));
    if (
      evidence.candidate?.runId !== reference.runId ||
      evidence.candidate?.attempt !== reference.attempt
    )
      throw new Error('Candidate held: artifact belongs to another attempt');
    validatePromotionPr({
      pr,
      repository,
      reference,
      candidate: evidence.candidate,
      merged: mode === 'production',
    });
    // Also prove main ancestry from repository commits, not artifact claims.
    git('fetch', 'origin', currentMainSha, evidence.candidate.sha);
    git('merge-base', '--is-ancestor', currentMainSha, evidence.candidate.sha);
    if (
      git('rev-parse', `${evidence.candidate.sha}^{tree}`) !== evidence.candidate.tree ||
      git('rev-parse', `${currentMainSha}^{tree}`) !== evidence.candidate.mainTree
    )
      throw new Error('Candidate held: repository trees differ from evidence');
    return verifyCandidateEvidence({ evidence, run, currentMainSha, actualTree, maxAgeSeconds });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const candidate = runCandidateGate({ mode: process.argv[2] });
    console.log(`Candidate verified: ${candidate.sha} (tree ${candidate.tree})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate held: gate failed');
    process.exitCode = 1;
  }
}
