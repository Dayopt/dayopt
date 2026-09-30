import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectOnePasswordConfig } from './agent-service-account.mjs';

const script = resolve('scripts/tasks/agent-service-account.mjs');
const accountId = 'a'.repeat(26);
const vaultId = 'd'.repeat(26);
const fakeToken = 'ops_test_fixture';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-sa-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const log = join(root, 'calls.jsonl');
  mkdirSync(bin);
  const op = join(bin, 'op');
  writeFileSync(
    op,
    `#!${process.execPath}
const fs = require('node:fs');
const env = process.env;
const args = process.argv.slice(2);
fs.appendFileSync(env.TEST_OP_LOG, JSON.stringify({
  args, config: env.OP_CONFIG_DIR,
  opKeys: Object.keys(env).filter(key => key.startsWith('OP_')).sort(),
  bio: env.OP_BIOMETRIC_UNLOCK_ENABLED, cache: env.OP_CACHE,
  debug: env.OP_DEBUG, masking: env.OP_RUN_NO_MASKING,
  configMode: fs.statSync(env.OP_CONFIG_DIR).mode & 0o777,
}) + '\\n');
if (!env.OP_SERVICE_ACCOUNT_TOKEN || env.TEST_OP_FAIL === 'yes') {
  console.log(env.OP_SERVICE_ACCOUNT_TOKEN || 'must-not-print');
  console.error(env.OP_SERVICE_ACCOUNT_TOKEN || 'must-not-print');
  process.exit(1);
}
if (env.TEST_OP_INVALID_JSON === 'yes') {
  console.log('invalid-json:' + env.OP_SERVICE_ACCOUNT_TOKEN);
  process.exit(0);
}
if (JSON.stringify(args) === JSON.stringify(['user', 'get', '--me', '--format=json'])) {
  console.log(JSON.stringify({
    id: env.TEST_USER_ID || env.DAYOPT_AGENT_SERVICE_ACCOUNT_ID,
    type: env.TEST_USER_TYPE || 'SERVICE_ACCOUNT',
    state: env.TEST_USER_STATE || 'ACTIVE',
  }));
} else if (JSON.stringify(args) === JSON.stringify(['vault', 'list', '--format=json'])) {
  if (env.TEST_OP_VAULT_FAIL === 'yes') {
    console.log(env.OP_SERVICE_ACCOUNT_TOKEN);
    console.error(env.OP_SERVICE_ACCOUNT_TOKEN);
    process.exit(1);
  }
  console.log(env.TEST_VAULTS || JSON.stringify([{id: env.DAYOPT_AGENT_VAULT_ID, name: 'agent'}]));
} else {
  process.exit(2);
}
`,
  );
  chmodSync(op, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OP_SERVICE_ACCOUNT_TOKEN: fakeToken,
    DAYOPT_AGENT_SERVICE_ACCOUNT_ID: accountId,
    DAYOPT_AGENT_VAULT_ID: vaultId,
    TEST_OP_LOG: log,
    ...extraEnv,
  };
  return {
    root,
    log,
    run(args = ['check', '--json']) {
      return spawnSync(process.execPath, [script, ...args], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      });
    },
    calls() {
      return existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}

describe('agent service-account authentication', () => {
  it('stops before invoking op or the work command when the token is missing', () => {
    const f = fixture({ OP_SERVICE_ACCOUNT_TOKEN: '' });
    const marker = join(f.root, 'work-started');
    const result = f.run([
      'run',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TOKEN_MISSING');
    expect(f.calls()).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    [{ OP_SERVICE_ACCOUNT_TOKEN: 'personal-session' }, 'TOKEN_INVALID'],
    [{ DAYOPT_AGENT_SERVICE_ACCOUNT_ID: '' }, 'ACCOUNT_ID_REQUIRED'],
    [{ DAYOPT_AGENT_VAULT_ID: 'agent' }, 'VAULT_ID_REQUIRED'],
  ])('requires pinned IDs and a service-account token: %s', (env, code) => {
    const f = fixture(env);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
    expect(f.calls()).toEqual([]);
  });

  it('verifies the active service account and the complete vault list without reading items', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      identity: 'SERVICE_ACCOUNT',
      vaultScope: 'agent-only',
      permissions: 'requires-admin-verification',
      runtimeIsolation: 'requires-cloud-verification',
    });
    expect(f.calls().map((call) => call.args)).toEqual([
      ['user', 'get', '--me', '--format=json'],
      ['vault', 'list', '--format=json'],
    ]);
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it.each([
    { TEST_USER_TYPE: 'HUMAN' },
    { TEST_USER_STATE: 'SUSPENDED' },
    { TEST_USER_ID: 'b'.repeat(26) },
  ])('rejects a personal, inactive, or different identity before requesting vaults: %s', (env) => {
    const f = fixture(env);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('IDENTITY_MISMATCH');
    expect(f.calls()).toHaveLength(1);
  });

  it.each([
    { vaults: [] },
    { vaults: [{ id: vaultId, name: 'human' }] },
    { vaults: [{ id: 'b'.repeat(26), name: 'agent' }] },
    {
      vaults: [
        { id: vaultId, name: 'agent' },
        { id: 'b'.repeat(26), name: 'human' },
      ],
    },
    {
      vaults: [
        { id: vaultId, name: 'agent' },
        { id: 'c'.repeat(26), name: 'ci' },
      ],
    },
    { vaults: { id: vaultId, name: 'agent' } },
  ])('does not run work when the accessible vault set differs: %j', ({ vaults }) => {
    const f = fixture({ TEST_VAULTS: JSON.stringify(vaults) });
    const marker = join(f.root, 'work-started');
    const result = f.run([
      'run',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VAULT_SCOPE_MISMATCH');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it('removes all personal and Connect authentication settings for both probes and work', () => {
    const f = fixture({
      OP_CONNECT_HOST: 'https://connect.invalid',
      OP_CONNECT_TOKEN: 'connect-fixture',
      OP_SESSION: 'session-fixture',
      OP_SESSION_personal: 'named-session-fixture',
      OP_ACCOUNT: 'personal',
      OP_CONFIG_DIR: '/must-not-use-personal-config',
      OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
      OP_DEBUG: 'true',
      OP_RUN_NO_MASKING: 'true',
    });
    const result = f.run([
      'run',
      '--',
      process.execPath,
      '-e',
      `console.log(JSON.stringify({
        config: process.env.OP_CONFIG_DIR,
        bio: process.env.OP_BIOMETRIC_UNLOCK_ENABLED,
        connect: Boolean(process.env.OP_CONNECT_TOKEN),
        session: Object.keys(process.env).some(k => k.startsWith('OP_SESSION')),
        tokenPresent: Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN),
      }))`,
    ]);
    expect(result.status).toBe(0);
    const child = JSON.parse(result.stdout);
    expect(child).toMatchObject({
      bio: 'false',
      connect: false,
      session: false,
      tokenPresent: true,
    });
    expect(child.config).not.toBe('/must-not-use-personal-config');
    for (const call of f.calls()) {
      expect(call.config).toBe(child.config);
      expect(call.configMode).toBe(0o700);
      expect(call.opKeys).toEqual([
        'OP_BIOMETRIC_UNLOCK_ENABLED',
        'OP_CACHE',
        'OP_CONFIG_DIR',
        'OP_DEBUG',
        'OP_RUN_NO_MASKING',
        'OP_SERVICE_ACCOUNT_TOKEN',
      ]);
      expect(call.bio).toBe('false');
      expect(call.cache).toBe('false');
      expect(call.debug).toBe('false');
      expect(call.masking).toBe('false');
    }
    expect(existsSync(child.config)).toBe(false);
  });

  it.each([
    [{ TEST_OP_FAIL: 'yes' }, 'AUTH_FAILED'],
    [{ TEST_OP_VAULT_FAIL: 'yes' }, 'VAULT_LIST_FAILED'],
    [{ TEST_OP_INVALID_JSON: 'yes' }, 'METADATA_INVALID'],
  ])('suppresses raw CLI stdout/stderr even when they contain a token: %s', (env, code) => {
    const f = fixture(env);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
    expect(result.stdout + result.stderr).not.toContain(fakeToken);
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it('preserves command arguments literally without invoking a shell', () => {
    const f = fixture();
    const literal = '$(must-not-execute); echoed';
    const result = f.run([
      'run',
      '--',
      process.execPath,
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      literal,
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([literal]);
  });

  it('fails closed when the CLI is unavailable', () => {
    const f = fixture({ PATH: '/nonexistent-cli-directory' });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTH_FAILED');
    expect(result.stdout + result.stderr).not.toContain(fakeToken);
    expect(f.calls()).toEqual([]);
  });

  it('reports a command that cannot start without exposing raw errors', () => {
    const f = fixture();
    const result = f.run(['run', '--', '/nonexistent-work-command']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Agent secrets: COMMAND_START_FAILED\n');
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it('preserves a work-command failure and removes the temporary CLI configuration', () => {
    const f = fixture();
    const result = f.run(['run', '--', process.execPath, '-e', 'process.exit(17)']);
    expect(result.status).toBe(17);
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it('reports a terminated work command as a failure and cleans up', () => {
    const f = fixture();
    const result = f.run([
      'run',
      '--',
      process.execPath,
      '-e',
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    expect(result.status).toBe(143);
    expect(existsSync(f.calls()[0].config)).toBe(false);
  });

  it('does not put the token or authentication IDs into preflight metadata', () => {
    const state = collectOnePasswordConfig({
      OP_SERVICE_ACCOUNT_TOKEN: fakeToken,
      DAYOPT_AGENT_SERVICE_ACCOUNT_ID: accountId,
      DAYOPT_AGENT_VAULT_ID: vaultId,
    });
    expect(state).toMatchObject({
      tokenPresent: true,
      scope: 'unverified',
      runtimeIsolation: 'unverified',
    });
    expect(JSON.stringify(state)).not.toContain(fakeToken);
    expect(JSON.stringify(state)).not.toContain(accountId);
    expect(JSON.stringify(state)).not.toContain(vaultId);
  });
});
