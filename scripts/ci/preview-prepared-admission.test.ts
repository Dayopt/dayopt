import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertPreparedPreviewAdmission } from './preview-prepared-admission.mjs';
const request = {
  prNumber: 2954,
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test',
  branchName: 'codex/test',
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  supabaseBranchId: '11111111-1111-4111-8111-111111111111',
  databaseMode: 'ephemeral',
};
describe('prepared workflow admission', () => {
  it.each([
    {},
    { terminalVerified: true },
    { status: 404 },
    { status: 'REMOVED' },
    { trustedSources: true },
  ])('cannot turn provider observations or flags into an execution permission', (extra) => {
    expect(() => assertPreparedPreviewAdmission({ ...request, ...extra })).toThrow();
  });
  it('blocks before an environment, credential or candidate job can run', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const trust = workflow.slice(
      workflow.indexOf('  preview-trust:'),
      workflow.indexOf('  preview-e2e:'),
    );
    expect(trust).toContain('node scripts/ci/preview-prepared-admission.mjs');
    expect(trust).not.toMatch(/secrets\.|id-token:|environment:/);
    expect(workflow.slice(workflow.indexOf('  preview-e2e:'))).toContain(
      "needs.preview-trust.result == 'success'",
    );
  });
});
