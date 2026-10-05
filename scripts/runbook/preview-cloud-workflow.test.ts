import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const cloud = workflow.slice(workflow.indexOf('\n  preview-trust:'));
describe('Cloud Preview credential wiring', () => {
  it('requires an explicit dispatch on the trusted Integration workflow ref', () => {
    expect(
      cloud.match(
        /if: github.event_name == 'workflow_dispatch' && inputs.preview_e2e && inputs.preview_recover_run == '' && github.ref == 'refs\/heads\/integration'/g,
      ),
    ).toHaveLength(1);
    expect(cloud).toContain(
      "always() && needs.preview-trust.result == 'success' && github.event_name == 'workflow_dispatch' && inputs.preview_e2e && inputs.preview_recover_run == '' && github.ref == 'refs/heads/integration'",
    );
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('cancel-in-progress: ${{ !inputs.preview_e2e }}');
    expect(workflow).not.toContain('pull_request_target:');
  });
  it('uses an internal PR gate before the environment worker and repeats it before credentials', () => {
    expect(cloud).toContain('needs: preview-trust');
    expect(cloud).toContain('environment: Preview – product');
    expect(cloud.match(/run: node scripts\/ci\/preview-cloud-trust.mjs/g)).toHaveLength(3);
    const gate = cloud.lastIndexOf('run: node scripts/ci/preview-cloud-trust.mjs');
    const execute = cloud.indexOf('- id: execute');
    expect(gate).toBeLessThan(execute);
    expect(cloud.slice(0, execute)).not.toMatch(
      /secrets\.(PREVIEW_E2E_SUPABASE_KEY|PREVIEW_E2E_BYPASS_SECRET|PREVIEW_E2E_SUPABASE_READINESS_TOKEN)/,
    );
  });
  it('uses a short-lived GitHub read token for provider provenance without a Vercel PAT', () => {
    const worker = cloud.slice(
      cloud.indexOf('\n  preview-e2e:'),
      cloud.indexOf('\n  preview-recovery-trust:'),
    );
    expect(worker).toContain('deployments: read');
    expect(worker).toContain('statuses: read');
    expect(worker.slice(worker.indexOf('- id: execute'))).toContain(
      'GITHUB_TOKEN: ${{ github.token }}',
    );
    expect(cloud).not.toContain('PREVIEW_E2E_VERCEL_TOKEN');
    expect(cloud).not.toMatch(/\bVERCEL_TOKEN:/);
  });
  it('runs trusted supervisor scripts rather than candidate runner code and publishes one sanitized JSON', () => {
    expect(cloud).toContain('ref: ${{ needs.preview-trust.outputs.sha }}');
    expect(cloud).toContain('path: candidate');
    expect(cloud).not.toContain('node candidate/');
    expect(cloud).toContain('path: ${{ runner.temp }}/preview-public/preview.json');
    expect(cloud).not.toMatch(/path:.*(private|screenshot|\*\*)/);
    expect(cloud.match(/always\(\) && steps.execute.outcome != 'skipped'/g)).toHaveLength(3);
  });
  it('never installs or executes candidate dependencies on the credentialed worker', () => {
    expect(cloud).not.toMatch(/pnpm --dir candidate/);
    expect(cloud).toContain('pnpm --dir apps/product exec playwright install --with-deps chromium');
  });
  it('passes user input through environment JSON rather than interpolating it into shell', () => {
    expect(cloud).toContain('PREVIEW_REQUEST_JSON: ${{ toJSON(inputs) }}');
    for (const line of cloud.split('\n').filter((line) => line.includes('run:'))) {
      expect(line).not.toContain('${{ inputs.');
    }
  });
  it('saves the exact run intent before any candidate checkout or dependency execution', () => {
    const persist = cloud.indexOf('name: Persist the public recovery intent');
    const candidate = cloud.indexOf('name: Checkout the exact reviewed candidate');
    expect(persist).toBeGreaterThan(0);
    expect(persist).toBeLessThan(candidate);
    expect(cloud).toContain('name: preview-intent-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(cloud.slice(0, persist)).not.toMatch(/secrets\.PREVIEW_E2E_/);
    expect(cloud.match(/preview-cloud-run\.mjs.*preview-intent\/intent\.json/g)).toHaveLength(3);
  });
  it('recovers on a trusted worker with no candidate code and one selected nonproduction key', () => {
    const recovery = cloud.slice(cloud.indexOf('\n  preview-recovery-trust:'));
    expect(recovery).toContain('needs: preview-recovery-trust');
    expect(recovery).toContain("inputs.preview_recover_run != ''");
    expect(recovery).toContain('cancel-in-progress: false');
    expect(recovery).not.toContain('path: candidate');
    expect(recovery).not.toContain('pnpm');
    expect(recovery.match(/secrets\.[A-Z0-9_]+/g)).toEqual(['secrets.PREVIEW_E2E_SUPABASE_KEY']);
    expect(recovery).toContain('path: ${{ runner.temp }}/preview-recovery/recovery.json');
  });
});
