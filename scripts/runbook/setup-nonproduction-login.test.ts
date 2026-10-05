import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts/runbook/setup-nonproduction-login.sh');

function runFakeSetup({
  opFails = false,
  vaultRequired = false,
  startupFails = false,
  provisionVaultId,
  policies = 'branch\tmain\nbranch\tintegration',
  environmentPolicy = 'false\ttrue',
}: {
  opFails?: boolean;
  vaultRequired?: boolean;
  startupFails?: boolean;
  provisionVaultId?: string;
  policies?: string;
  environmentPolicy?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nonprod-login-'));
  try {
    const opPath = join(dir, 'op');
    const ghPath = join(dir, 'gh');
    const startupPath = join(dir, 'startup-check.py');
    const callsPath = join(dir, 'calls');
    const readsPath = join(dir, 'op-reads');
    writeFileSync(startupPath, `import sys\nsys.exit(${startupFails ? 1 : 0})\n`);
    writeFileSync(
      opPath,
      `#!/bin/bash\nif [[ "${'${1:-}'}" == item ]]; then\n  field=''\n  vault=''\n  while (($#)); do\n    case "$1" in --fields) field="$2"; shift 2 ;; --vault) vault="$2"; shift 2 ;; *) shift ;; esac\n  done\n  [[ "${'${OP_VAULT_REQUIRED:-0}'}" == 1 && -z "$vault" ]] && { printf 'vault required' >&2; exit 1; }\n  [[ "${'${OP_FAIL:-0}'}" == 1 && "$field" == password ]] && exit 1\n  case "$field" in username) printf 'fake@example.test' ;; password) printf 'fake-password' ;; esac\nelif [[ "${'${1:-}'}" == read ]]; then\n  printf '%s\\n' "${'${2:-}'}" >> "${'${OP_READS_FILE}'}"\n  [[ -n "${'${OP_EXPECT_PROVISION_REF:-}'}" && "${'${2:-}'}" != "$OP_EXPECT_PROVISION_REF" ]] && exit 1\n  printf 'fake-management-token'\nelse\n  exit 1\nfi\n`,
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
        OP_READS_FILE: readsPath,
        OP_FAIL: opFails ? '1' : '0',
        OP_VAULT_REQUIRED: vaultRequired ? '1' : '0',
        OP_EXPECT_PROVISION_REF: provisionVaultId
          ? `op://${provisionVaultId}/supabase-preview-provision/credential`
          : 'op://ci/supabase-preview-provision/credential',
        NONPROD_LOGIN_VAULT_ID: 'owner-managed-vault-id',
        NONPROD_LOGIN_PROVISION_VAULT_ID: provisionVaultId,
        POLICIES: policies,
        ENVIRONMENT_POLICY: environmentPolicy,
      },
    });
    return {
      result,
      calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
      reads: existsSync(readsPath) ? readFileSync(readsPath, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('setup-nonproduction-login secret sync', () => {
  it('preflights 1Password values and preserves exact existing branch policies', () => {
    const { result, calls, reads } = runFakeSetup();
    expect(result.status).toBe(0);
    expect(calls.match(/secret set/g)).toHaveLength(3);
    expect(calls.match(/deployment-branch-policies/g)).toBeNull();
    expect(calls).not.toContain('fake-password');
    expect(calls).not.toContain('fake-management-token');
    expect(reads).toBe('op://ci/supabase-preview-provision/credential\n');
  });

  it('stops before GitHub writes when 1Password field resolution fails', () => {
    const { result, calls } = runFakeSetup({ opFails: true });
    expect(result.status).not.toBe(0);
    expect(calls).toBe('');
    expect(result.stderr).not.toContain('fake-password');
  });

  it('passes the owner-supplied vault explicitly when resolving the login item', () => {
    const { result, calls } = runFakeSetup({ vaultRequired: true });
    expect(result.status).toBe(0);
    expect(calls.match(/secret set/g)).toHaveLength(3);
    expect(calls).not.toContain('owner-managed-vault-id');
  });

  it('resolves the Management PAT from an owner-supplied vault when provided', () => {
    const { result, calls, reads } = runFakeSetup({ provisionVaultId: 'owner-pat-vault-id' });
    expect(result.status).toBe(0);
    expect(calls.match(/secret set/g)).toHaveLength(3);
    expect(reads).toBe('op://owner-pat-vault-id/supabase-preview-provision/credential\n');
    expect(calls).not.toContain('owner-pat-vault-id');
  });

  it('rejects malformed provision vault locators before GitHub writes', () => {
    const { result, calls, reads } = runFakeSetup({ provisionVaultId: 'other/vault' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('secret set');
    expect(reads).toBe('');
  });

  it('stops when the required startup check fails', () => {
    const { result, calls, reads } = runFakeSetup({ startupFails: true });
    expect(result.status).not.toBe(0);
    expect(calls).toBe('');
    expect(reads).toBe('');
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
