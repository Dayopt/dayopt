import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts/runbook/setup-nonproduction-login.sh');

function runFakeSetup({
  opFails = false,
  policies = 'branch\tmain\nbranch\tintegration',
  environmentPolicy = 'false\ttrue',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nonprod-login-'));
  try {
    const opPath = join(dir, 'op');
    const ghPath = join(dir, 'gh');
    const startupPath = join(dir, 'startup-check.py');
    const callsPath = join(dir, 'calls');
    writeFileSync(startupPath, '# fake startup check\n');
    writeFileSync(
      opPath,
      `#!/bin/bash\nif [[ "${'${1:-}'}" == item ]]; then\n  field="${'${5:-}'}"\n  [[ "${'${OP_FAIL:-0}'}" == 1 && "$field" == password ]] && exit 1\n  case "$field" in username) printf 'fake@example.test' ;; password) printf 'fake-password' ;; esac\nelse\n  printf 'fake-management-token'\nfi\n`,
    );
    writeFileSync(
      ghPath,
      `#!/bin/bash\nif [[ "${'${1:-}'}" == api && "${'${*}'}" == *deployment-branch-policies* && "${'${*}'}" != *'-X POST'* ]]; then\nprintf '%s' "${'${POLICIES:-}'}"\nexit 0\nfi\nif [[ "${'${1:-}'}" == api && "${'${*}'}" == *'environments/Nonproduction login'* ]]; then\nprintf '%s' "${'${ENVIRONMENT_POLICY:-}'}"\nexit 0\nfi\nif [[ "${'${1:-}'}" == secret && "${'${2:-}'}" == set ]]; then cat >/dev/null; fi\nprintf '%s\\n' "$*" >> "${'${CALLS_FILE}'}"\n`,
    );
    chmodSync(opPath, 0o755);
    chmodSync(ghPath, 0o755);
    const result = spawnSync('bash', [script, '--execute'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OP_BIN_DIR: dir,
        OP_STARTUP_CHECK: startupPath,
        CALLS_FILE: callsPath,
        OP_FAIL: opFails ? '1' : '0',
        POLICIES: policies,
        ENVIRONMENT_POLICY: environmentPolicy,
      },
    });
    return { result, calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('setup-nonproduction-login secret sync', () => {
  it('preflights 1Password values and preserves exact existing branch policies', () => {
    const { result, calls } = runFakeSetup();
    expect(result.status).toBe(0);
    expect(calls.match(/secret set/g)).toHaveLength(3);
    expect(calls.match(/deployment-branch-policies/g)).toBeNull();
    expect(calls).not.toContain('fake-password');
    expect(calls).not.toContain('fake-management-token');
  });

  it('stops before GitHub writes when 1Password field resolution fails', () => {
    const { result, calls } = runFakeSetup({ opFails: true });
    expect(result.status).not.toBe(0);
    expect(calls).toBe('');
    expect(result.stderr).not.toContain('fake-password');
  });

  it('fails closed when an unexpected branch policy is present', () => {
    const { result, calls } = runFakeSetup({ policies: 'branch\tmain\nbranch\tother' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('secret set');
    expect(calls).not.toContain('deployment-branch-policies -X POST');
  });

  it('fails closed when the Environment itself is not restricted to custom branches', () => {
    const { result, calls } = runFakeSetup({ environmentPolicy: 'true\tfalse' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('secret set');
  });
});
