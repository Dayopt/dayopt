import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const cloud = workflow.slice(workflow.indexOf('\n  preview-trust:'));
describe('Cloud Preview credential wiring', () => {
  it('requires an explicit dispatch on the trusted Integration workflow ref', () => {
    expect(
      cloud.match(
        /if: github.event_name == 'workflow_dispatch' && inputs.preview_e2e && github.ref == 'refs\/heads\/integration'/g,
      ),
    ).toHaveLength(1);
    expect(cloud).toContain(
      "always() && needs.preview-trust.result == 'success' && github.event_name == 'workflow_dispatch' && inputs.preview_e2e && github.ref == 'refs/heads/integration'",
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
      /secrets\.(PREVIEW_E2E_VERCEL_TOKEN|PREVIEW_E2E_SUPABASE_KEY|PREVIEW_E2E_BYPASS_SECRET|PREVIEW_E2E_SUPABASE_READINESS_TOKEN)/,
    );
  });
  it('runs trusted supervisor scripts rather than candidate runner code and publishes one sanitized JSON', () => {
    expect(cloud).toContain('ref: ${{ needs.preview-trust.outputs.sha }}');
    expect(cloud).toContain('path: candidate');
    expect(cloud).not.toContain('node candidate/');
    expect(cloud).toContain('path: ${{ runner.temp }}/preview-public/preview.json');
    expect(cloud).not.toMatch(/path:.*(private|screenshot|\*\*)/);
    expect(cloud.match(/always\(\) && steps.execute.outcome != 'skipped'/g)).toHaveLength(3);
  });
  it('passes user input through environment JSON rather than interpolating it into shell', () => {
    expect(cloud).toContain('PREVIEW_REQUEST_JSON: ${{ toJSON(inputs) }}');
    for (const line of cloud.split('\n').filter((line) => line.includes('run:'))) {
      expect(line).not.toContain('${{ inputs.');
    }
  });
});
