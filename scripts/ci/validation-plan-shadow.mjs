#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidationPlan, formatValidationPlan } from '../lib/validation-plan.mjs';
import { gitDiffFiles } from './impact.mjs';

/** Full git objects avoid API pagination limits and retain deleted/renamed paths. */
export function collectPlanInput({
  repository,
  prNumber,
  headSha,
  baseSha,
  testSha,
  policySha,
  cwd,
  event,
}) {
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  for (const revision of [headSha, baseSha, testSha, policySha]) {
    if (
      !/^[a-f0-9]{40}$/.test(revision) ||
      git(['rev-parse', '--verify', `${revision}^{commit}`]).trim() !== revision
    )
      throw new Error('Unresolved revision');
  }
  const parents = git(['show', '-s', '--format=%P', testSha]).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha)
    throw new Error('Test revision is not the exact PR merge');
  const mergeBase = git(['merge-base', baseSha, headSha]).trim();
  const files = gitDiffFiles(mergeBase, headSha, { cwd });
  const patch = execFileSync(
    'git',
    ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, headSha],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    repository,
    prNumber,
    headSha,
    baseSha,
    testSha,
    policySha,
    event,
    diff: { complete: true, files, hash: createHash('sha256').update(patch).digest('hex') },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const input = collectPlanInput({
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: event.number,
    headSha: event.pull_request?.head.sha,
    baseSha: event.pull_request?.base.sha,
    testSha: process.env.GITHUB_SHA,
    policySha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    cwd: resolve(process.argv[2]),
    event: process.env.GITHUB_EVENT_NAME,
  });
  const plan = createValidationPlan(input);
  writeFileSync(resolve(process.argv[3]), `${JSON.stringify(plan, null, 2)}\n`);
  const summary = formatValidationPlan(plan);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
