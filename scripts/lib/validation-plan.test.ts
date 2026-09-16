import { describe, expect, it } from 'vitest';
import { createValidationPlan, formatValidationPlan } from './validation-plan.mjs';

const input = (files: string[]) => ({
  repository: 'Dayopt/dayopt',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  testSha: 'c'.repeat(40),
  policySha: 'b'.repeat(40),
  event: 'pull_request',
  diff: { complete: true, files, hash: 'd'.repeat(64) },
});
const graph = new Map([['packages/components', new Set(['product', 'web'])]]);
const plan = (files: string[]) => createValidationPlan(input(files), { graph });

describe('trusted validation plan', () => {
  it('allows only explicit prose to omit review and app/DB execution', () => {
    const result = plan(['README.md']);
    expect(result.status).toBe('determinate');
    expect(result.review.status).toBe('not-applicable');
    expect(result.required.productPreview.status).toBe('not-applicable');
    expect(result.required.dbUpgrade.status).toBe('not-applicable');
    expect(result.required.static.status).toBe('required');
  });
  it.each([
    'AGENTS.md',
    '.agents/skills/test/SKILL.md',
    '.github/workflows/ci.yml',
    'scripts/ci/validation-plan.mjs',
    'docs/security.md',
    'apps/web/content/docs/a.mdx',
    'apps/product/src/a.css',
    'apps/product/src/a.tsx',
    'apps/product/src/lib/time/a.ts',
    'apps/product/src/app/api/mcp/a.ts',
    'pnpm-lock.yaml',
  ])('requires review for %s', (file) => {
    expect(plan([file]).review.status).toBe('required');
  });
  it('does not confuse policy review with app build', () => {
    const result = plan(['AGENTS.md']);
    expect(result.required.productPreview.status).toBe('not-applicable');
    expect(result.required.scripts.status).toBe('required');
  });
  it('unions README and RLS requirements, including independent migration paths', () => {
    const result = plan(['README.md', 'supabase/migrations/20260916_rls.sql']);
    for (const name of ['integration', 'dbFresh', 'dbUpgrade', 'oldConsumer'] as const)
      expect(result.required[name].status).toBe('required');
    expect(result.authority.productionAuthorized).toBe(false);
  });
  it('propagates shared workspace dependencies', () => {
    const result = plan(['packages/components/src/a.tsx']);
    expect(result.required.productPreview.status).toBe('required');
    expect(result.required.webPreview.status).toBe('required');
  });
  it('requires broad validation for unknown paths', () => {
    const result = plan(['new-root/file']);
    expect(Object.values(result.required).every((rule) => rule.status === 'required')).toBe(true);
  });
  it.each([
    { diff: { complete: false, files: ['README.md'], hash: 'd'.repeat(64) } },
    { diff: { complete: true, files: [], hash: 'd'.repeat(64) } },
    { headSha: '' },
    { policySha: 'a'.repeat(40) },
    { event: 'workflow_dispatch', prNumber: null },
  ])('rejects incomplete or self-exempting identity %j', (patch) => {
    const result = createValidationPlan({ ...input(['README.md']), ...patch }, { graph });
    expect(result.status).toBe('indeterminate');
    expect(Object.values(result.required).every((rule) => rule.status === 'indeterminate')).toBe(
      true,
    );
    expect(result.review.status).toBe('indeterminate');
  });
  it('is deterministic and explains revisions and legacy differences', () => {
    const result = plan(['AGENTS.md']);
    expect(plan(['AGENTS.md'])).toEqual(result);
    expect(formatValidationPlan(result)).toContain('Legacy comparison');
    expect(formatValidationPlan(result)).toContain(result.identity.testSha);
  });
});
