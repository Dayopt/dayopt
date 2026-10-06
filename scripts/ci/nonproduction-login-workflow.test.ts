import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  join(process.cwd(), '.github/workflows/nonproduction-login.yml'),
  'utf8',
);
const section = (name: string) => {
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start < 0) throw new Error(`workflow job ${name} is missing`);
  const next = workflow.slice(start + 3).search(/^  [a-z][a-z0-9_-]*:\n/m);
  return workflow.slice(start, next < 0 ? undefined : start + 3 + next);
};

describe('nonproduction-login workflow trust boundary', () => {
  it('runs pull_request_target only for main/integration base refs and manual Integration dispatch', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('branches: [main, integration]');
    expect(workflow).toContain("github.ref == 'refs/heads/integration'");
    expect(workflow).toContain('node scripts/ci/nonproduction-login-trust.mjs');
  });

  it('validates the live candidate before the protected environment receives credentials', () => {
    const trust = section('trust');
    const provision = section('provision');
    expect(workflow).toContain('pull-requests: read');
    expect(trust).toContain('node scripts/ci/nonproduction-login-trust.mjs');
    expect(trust).not.toContain('supabase/**');
    expect(trust).toContain('ref: ${{ github.sha }}');
    expect(trust).not.toContain('secrets.');
    expect(trust).not.toContain('github.event.pull_request.head.sha }}');
    expect(provision).toContain('needs: trust');
    expect(provision).toContain('environment: Nonproduction login');
    expect(provision).toContain('ref: ${{ github.sha }}');
    expect(provision).toContain('run: node scripts/ci/nonproduction-login-provision.mjs');
    expect(provision).toContain(
      "needs.trust.outputs.target == 'integration' && secrets.NONPROD_LOGIN_EMAIL",
    );
    expect(provision).toContain(
      "needs.trust.outputs.target == 'integration' && secrets.NONPROD_LOGIN_PASSWORD",
    );
    expect(provision).toContain(
      "needs.trust.outputs.target == 'preview' && secrets.NONPROD_PREVIEW_LOGIN_EMAIL",
    );
    expect(provision).toContain(
      "needs.trust.outputs.target == 'preview' && secrets.NONPROD_PREVIEW_LOGIN_PASSWORD",
    );
    expect(provision).toContain('secrets.SUPABASE_PREVIEW_PROVISION_TOKEN');
    expect(provision).not.toContain('github.event.pull_request.head.sha }}');
    expect(provision).not.toContain('NONPROD_LOGIN_DATABASE_MODE');
  });

  it('serializes concurrent provisioning on the same nonproduction account', () => {
    expect(workflow).toContain(
      'group: nonproduction-login-${{ github.event.pull_request.number || inputs.preview_pr || inputs.target',
    );
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
