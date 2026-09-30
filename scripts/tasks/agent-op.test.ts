import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-agent-op-test-'));
  roots.push(root);
  const log = join(root, 'calls.jsonl');
  writeFileSync(log, '');
  const binary = join(root, 'op');
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), e = process.env;
fs.appendFileSync(e.TEST_LOG, JSON.stringify({args:a, sa:!!e.OP_SERVICE_ACCOUNT_TOKEN, connect:!!e.OP_CONNECT_TOKEN, session:!!e.OP_SESSION, biometric:e.OP_BIOMETRIC_UNLOCK_ENABLED})+'\\n');
if (a[0] === 'item' && a[1] === 'get') {
  if (e.TEST_BOOTSTRAP_FAIL) { console.error('ops_test_private'); process.exit(1); }
  console.log(JSON.stringify({fields:[{value:e.TEST_BAD_TOKEN ? 'invalid' : 'ops_test_private'}]}));
} else if (a[0] === 'user') {
  console.log(JSON.stringify({id:e.DAYOPT_AGENT_SERVICE_ACCOUNT_ID, type:'SERVICE_ACCOUNT', state:'ACTIVE'}));
} else if (a[0] === 'vault') {
  console.log(JSON.stringify([{id:e.DAYOPT_AGENT_VAULT_ID, name:e.TEST_BAD_SCOPE ? 'human' : 'agent'}]));
} else { process.exit(7); }
`,
  );
  chmodSync(binary, 0o755);
  const config = {
    binary,
    account: 'a'.repeat(26),
    vault: 'b'.repeat(26),
    item: 'c'.repeat(26),
    serviceAccountId: 'd'.repeat(26),
    agentVaultId: 'e'.repeat(26),
  };
  const runner = join(root, 'runner.mjs');
  writeFileSync(
    runner,
    `import {runAgentOp} from ${JSON.stringify(resolve('scripts/tasks/agent-op.mjs'))};
try { process.exitCode = await runAgentOp(process.argv.slice(2), ${JSON.stringify(config)}, process.env); }
catch (e) { console.error(e.message); process.exitCode = 1; }
`,
  );
  return {
    run(args = ['vault', 'list']) {
      return spawnSync(process.execPath, [runner, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_LOG: log,
          OP_CONNECT_TOKEN: 'unwanted-connect',
          OP_SESSION: 'unwanted-session',
          ...extraEnv,
        },
      });
    },
    calls() {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

describe('agent op entry point', () => {
  it('resolves only the configured item, verifies the SA, then runs an unfiltered vault list', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 'e'.repeat(26), name: 'agent' }]);
    const calls = f.calls();
    expect(calls).toHaveLength(4);
    expect(calls[0].args).toEqual([
      'item',
      'get',
      'c'.repeat(26),
      '--vault',
      'b'.repeat(26),
      '--account',
      'a'.repeat(26),
      '--format=json',
    ]);
    expect(calls[0].sa).toBe(false);
    expect(
      calls
        .slice(1)
        .every((call) => call.sa && !call.connect && !call.session && call.biometric === 'false'),
    ).toBe(true);
    expect(calls[3].args).toEqual(['vault', 'list']);
    expect(result.stdout + result.stderr).not.toContain('ops_test_private');
  });

  it('stops on bootstrap failure without exposing stderr or using human auth for the requested command', () => {
    const f = fixture({ TEST_BOOTSTRAP_FAIL: '1' });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOOTSTRAP_FAILED');
    expect(result.stdout + result.stderr).not.toContain('ops_test_private');
    expect(f.calls()).toHaveLength(1);
  });

  it('stops when the stored item has no SA token', () => {
    const f = fixture({ TEST_BAD_TOKEN: '1' });
    expect(f.run().stderr).toContain('TOKEN_FIELD_NOT_UNIQUE');
    expect(f.calls()).toHaveLength(1);
  });

  it('does not execute the requested command after a vault mismatch', () => {
    const f = fixture({ TEST_BAD_SCOPE: '1' });
    expect(f.run().stderr).toContain('VAULT_SCOPE_MISMATCH');
    expect(f.calls()).toHaveLength(3);
  });

  it.each([
    ['--account', 'other', 'vault', 'list'],
    ['vault', 'list', '--session=other'],
    ['signin'],
    ['--config=/other', 'vault', 'list'],
  ])('rejects authentication overrides: %j', (...args) => {
    const f = fixture();
    expect(f.run(args).stderr).toContain('AUTH_OVERRIDE_DENIED');
    expect(f.calls()).toHaveLength(0);
  });
});
