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
    // 元の assertion は `scripts` も required に固定していたが、producer の `📦 Unit Tests` は
    // ci.yml が docs-only で skip するため満たされず、恒久 blocked になっていた（#2821）。
    // policy 文書に求めるのは review と static の 2 つで、app build は要らない、が本来の意図。
    const result = plan(['AGENTS.md']);
    expect(result.required.productPreview.status).toBe('not-applicable');
    expect(result.required.static.status).toBe('required');
    expect(result.review.status).toBe('required');
    expect(result.review.protected).toBe(true);
  });
  it('unions README and RLS requirements, including independent migration paths', () => {
    const result = plan(['README.md', 'supabase/migrations/20260916000000_rls.sql']);
    for (const name of ['integration', 'dbFresh', 'dbUpgrade', 'oldConsumer'] as const)
      expect(result.required[name].status).toBe('required');
    expect(result.authority.productionAuthorized).toBe(false);
  });
  it('does not require the upgrade job for archive / non-migration files under supabase/migrations', () => {
    // 🧱 DB Upgrade (shadow) は root の migration ファイルでだけ起動する（check.mjs と同じ判定）。
    // plan 側が広く要求すると、起動しない job を待って Validation が恒久的に blocked になる
    const result = plan([
      'supabase/migrations/_archive/20250101000000_old.sql',
      'supabase/migrations/README.md',
    ]);
    expect(result.required.dbFresh.status).toBe('required');
    expect(result.required.dbUpgrade.status).toBe('not-applicable');
    expect(result.required.oldConsumer.status).toBe('not-applicable');
  });
  it('propagates shared workspace dependencies', () => {
    const result = plan(['packages/components/src/a.tsx']);
    expect(result.required.productPreview.status).toBe('required');
    expect(result.required.webPreview.status).toBe('required');
  });
  it.each([
    '.agents/skills/supabase/SKILL.md',
    '.agents/skills/supabase/references/postgres-rls-security.md',
    '.claude/skills/supabase/SKILL.md',
  ])('does not require integration for agent docs that only name supabase / rls: %s', (file) => {
    // impact.mjs はこれらを docs-only（integration=false）と判定するので 🧪 Integration Tests は
    // 起動しない。plan だけが database area を立てると、起動しない job を待って Validation が
    // 恒久的に blocked になる（#2815、PR #2813 で実発生）
    const result = plan([file]);
    expect(result.areas).not.toContain('database');
    expect(result.areas).not.toContain('unknown');
    expect(result.required.integration.status).toBe('not-applicable');
    expect(result.review.status).toBe('required');
  });
  it('still requires integration when the same change carries SQL', () => {
    const result = plan([
      '.agents/skills/supabase/SKILL.md',
      'supabase/migrations/20260916000000_rls.sql',
    ]);
    expect(result.areas).toContain('database');
    expect(result.required.integration.status).toBe('required');
  });
  it.each(['supabase/AGENTS.md', 'docs/engineering/data/db/rls-snapshot.md'])(
    'keeps the database area outside the agent guidance directories: %s',
    (file) => {
      // #2815 の除外は `.agents/` `.claude/` `.codex/` 配下の Markdown だけ。`docs/` の DB 契約を
      // api-db として扱う validation-shadow-report.mjs の判定がこの area に乗っている
      expect(plan([file]).areas).toContain('database');
      expect(plan([file]).required.integration.status).toBe('required');
    },
  );
  it.each([
    'AGENTS.md',
    '.agents/skills/test/SKILL.md',
    'docs/operations/tooling.md',
    'docs/engineering/data/architecture/model.c4',
  ])('does not require the scripts suite for documentation-only changes: %s', (file) => {
    // producer は `📦 Unit Tests` で、ci.yml は `needs.impact.outputs.docs_only == 'true'` で
    // これを skip する。plan が required にすると起動しない job を待って恒久 blocked になる
    // （#2821、PR #2819 で実発生）
    const result = plan([file]);
    expect(result.required.scripts.status).toBe('not-applicable');
    expect(result.required.static.status).toBe('required');
    expect(result.review.status).toBe('required');
  });
  it.each([
    'scripts/ci/impact.mjs',
    '.github/workflows/ci.yml',
    '.claude/settings.json',
    '.codex/hooks.json',
    'apps/product/src/a.ts',
  ])('keeps the scripts suite required when behavior can change: %s', (file) => {
    expect(plan([file]).required.scripts.status).toBe('required');
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
  // #2811 / PR #2868: repo 直下の設定と editor 設定が unknown へ落ちると databaseTests が
  // applicable になり、migration が無い PR が隔離 Supabase branch を待って恒久 blocked になる。
  it.each(['.gitignore', '.prettierignore', '.prettierrc', 'turbo.json', '.vscode/settings.json'])(
    'treats repo config %s as policy, not an unsatisfiable database requirement',
    (file) => {
      const result = plan([file]);
      expect(result.areas).not.toContain('unknown');
      expect(result.areas).toContain('policy');
      // migration が無いので隔離 DB は要求しない（Supabase Preview は起動しようがない）
      expect(result.environments.databaseTests).toBe('not-applicable');
      expect(result.review.protected).toBe(true);
    },
  );
  it('still fails closed for an unrecognized nested directory', () => {
    const result = plan(['terraform/main.tf']);
    expect(result.areas).toContain('unknown');
    expect(result.environments.databaseTests).toBe('disposable-local');
  });
  it('keeps requiring an isolated database when the PR really has a migration', () => {
    const result = plan(['supabase/migrations/20260920000000_add_column.sql']);
    expect(result.environments.databaseTests).toBe('disposable-local');
  });
  it('is deterministic and explains revisions and legacy differences', () => {
    const result = plan(['AGENTS.md']);
    expect(plan(['AGENTS.md'])).toEqual(result);
    expect(formatValidationPlan(result)).toContain('Legacy comparison');
    expect(formatValidationPlan(result)).toContain(result.identity.testSha);
  });
});
