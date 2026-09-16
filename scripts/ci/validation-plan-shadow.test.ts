import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createValidationPlan } from '../lib/validation-plan.mjs';
import { collectPlanInput } from './validation-plan-shadow.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'validation-plan-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git('init', '-b', 'main');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'user.name', 'Fixture');
mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
writeFileSync(join(cwd, 'supabase/migrations/base.sql'), 'select 1;\n');
git('add', 'supabase');
git('commit', '-m', 'baseline');
const baseSha = git('rev-parse', 'HEAD');
git('checkout', '-b', 'candidate');
renameSync(join(cwd, 'supabase/migrations/base.sql'), join(cwd, 'README.md'));
git('add', '-A');
git('commit', '-m', 'rename protected file to prose');
const headSha = git('rev-parse', 'HEAD');
git('checkout', 'main');
git('merge', '--no-ff', 'candidate', '-m', 'test merge');
const testSha = git('rev-parse', 'HEAD');
const params = {
  repository: 'Dayopt/dayopt',
  prNumber: 1,
  headSha,
  baseSha,
  testSha,
  policySha: baseSha,
  cwd,
  event: 'pull_request',
};
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('complete git collector', () => {
  it('retains deleted source and new destination of a rename', () => {
    const input = collectPlanInput(params);
    expect(input.diff.files).toEqual(['README.md', 'supabase/migrations/base.sql']);
    const result = createValidationPlan(input);
    expect(result.required.dbUpgrade.status).toBe('required');
    expect(result.review.status).toBe('required');
  });
  it('binds the complete patch and revisions deterministically', () => {
    expect(collectPlanInput(params)).toEqual(collectPlanInput(params));
    expect(collectPlanInput(params).diff.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('changes the diff hash when content changes without changing the path set', () => {
    const original = collectPlanInput(params);
    git('checkout', 'candidate');
    writeFileSync(join(cwd, 'README.md'), 'select 2;\n');
    git('add', 'README.md');
    git('commit', '-m', 'change content only');
    const changedHead = git('rev-parse', 'HEAD');
    const changedMerge = git(
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      baseSha,
      '-p',
      changedHead,
      '-m',
      'test changed merge',
    );
    const changed = collectPlanInput({ ...params, headSha: changedHead, testSha: changedMerge });
    expect(changed.diff.files).toEqual(original.diff.files);
    expect(changed.diff.hash).not.toBe(original.diff.hash);
  });
  it('rejects head-only results, mismatched merge parents and unresolved commits', () => {
    expect(() => collectPlanInput({ ...params, testSha: headSha })).toThrow('exact PR merge');
    expect(() => collectPlanInput({ ...params, headSha: baseSha })).toThrow('exact PR merge');
    expect(() => collectPlanInput({ ...params, headSha: 'f'.repeat(40) })).toThrow();
  });
});
