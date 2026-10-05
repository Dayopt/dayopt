import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANDIDATE_SUITES } from './release-candidate.mjs';

const workflows = join(process.cwd(), '.github/workflows');
const candidate = readFileSync(join(workflows, 'release-candidate.yml'), 'utf8');
const pinScript = readFileSync(join(process.cwd(), 'scripts/ci/release-candidate.mjs'), 'utf8');
const nightly = readFileSync(join(workflows, 'nightly.yml'), 'utf8');
const configAudit = readFileSync(join(workflows, 'production-config-audit.yml'), 'utf8');

describe('release candidate workflow contract', () => {
  const pinJob = candidate.slice(candidate.indexOf('\n  pin:'), candidate.indexOf('\n  verify:'));
  const verifyJob = candidate.slice(
    candidate.indexOf('\n  verify:'),
    candidate.indexOf('\n  notify_failure:'),
  );
  const failureJob = candidate.slice(candidate.indexOf('\n  notify_failure:'));

  it('has no schedule until the candidate time and delay budget are approved', () => {
    const triggers = candidate.slice(
      candidate.indexOf('\non:'),
      candidate.indexOf('\npermissions:'),
    );

    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toMatch(/^\s{2}schedule:/m);
    expect(candidate).toContain('RELEASE_CANDIDATE_ENABLED');
  });

  it('pins integration and main refs once on main and passes the immutable pin artifact onward', () => {
    expect(pinJob).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(pinJob).toContain('node scripts/ci/release-candidate.mjs pin candidate-pin.json');
    expect(pinJob).toContain('name: candidate-pin-${{ github.run_attempt }}');
    expect(pinJob).toContain('path: candidate-pin.json');
    expect(candidate).toContain('name: candidate-pin-${{ github.run_attempt }}');
    expect(candidate).toContain('name: candidate-evidence-${{ github.run_attempt }}');
    expect(candidate).not.toContain('inputs.sha');
    expect(pinScript).toContain('git/ref/heads/main');
    expect(pinScript).toContain('git/ref/heads/integration');
    expect(pinScript).toContain('main === controlSha');
    expect(pinScript).toContain("gitImpl('rev-parse', `${sha}^{tree}`)");
  });

  it('records an outcome for every required suite and seals only their exact set', () => {
    const results = candidate.slice(
      candidate.indexOf('CANDIDATE_RESULTS:'),
      candidate.indexOf('\n        run: node scripts/ci/release-candidate.mjs seal'),
    );
    for (const suite of CANDIDATE_SUITES) {
      expect(results).toContain(`"${suite}":"\${{ steps.${suite}.outcome }}"`);
      expect(verifyJob).toMatch(new RegExp(`^\\s*id: ${suite}\\s*$`, 'm'));
    }
    expect(verifyJob).toContain('node scripts/ci/release-candidate.mjs seal');
    expect(verifyJob).toContain('if-no-files-found: error');
  });

  it('runs candidate tests with read-only workflow permissions and only disposable DB credentials', () => {
    const permissions = candidate.slice(
      candidate.indexOf('\npermissions:'),
      candidate.indexOf('\nconcurrency:'),
    );
    const checkoutCredentials = verifyJob.match(/persist-credentials: false/g) ?? [];

    expect(permissions).toContain('contents: read');
    expect(permissions).toContain('actions: read');
    expect(permissions).not.toContain('issues: write');
    expect(verifyJob).not.toContain('secrets.');
    expect(verifyJob).toContain('run: supabase start');
    expect(verifyJob).toContain('NEXT_PUBLIC_SUPABASE_URL=');
    expect(verifyJob).toContain('USE_LOCAL_DB:');
    expect(checkoutCredentials).toHaveLength(2);
    expect(verifyJob).not.toMatch(/^\s*ref:\s*\$\{\{.*inputs\./m);
    expect(failureJob).toContain('issues: write');
  });

  it('keeps candidate failure Issue updates idempotent per workflow attempt', () => {
    expect(failureJob).toContain('--state open --search "$TITLE in:title"');
    expect(failureJob).toContain('if [ -n "$existing" ]; then');
    expect(failureJob).toContain('actions/runs/$GITHUB_RUN_ID (attempt $GITHUB_RUN_ATTEMPT)');
    expect(failureJob).toContain('if [ -z "$found" ]; then gh issue comment');
    expect(failureJob).toContain('gh issue create');
    expect(failureJob).not.toContain('git revert');
  });

  it('preserves the existing nightly backup and audit schedules', () => {
    expect(nightly).toContain("- cron: '0 22 * * *'");
    expect(nightly).toContain('storage-backup-export:');
    expect(nightly).toContain('bash scripts/ci/storage-backup.sh');
    expect(configAudit).toContain("- cron: '0 21 * * *'");
    expect(configAudit).toContain('production-config-audit.mjs');
  });
});
