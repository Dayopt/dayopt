import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateCodex, parsePatch } from './codex-pre-tool-guard.mjs';

const loader = resolve('scripts/hooks/codex-pre-tool-guard.sh');
let root: string;
let other: string;
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const check = (command: string) =>
  evaluateCodex(JSON.stringify({ cwd: root, tool_name: 'apply_patch', tool_input: { command } }));
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-codex-guard-'));
  other = mkdtempSync(join(tmpdir(), 'dayopt-codex-outside-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: root });
  expect(init.status).toBe(0);
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(root, 'supabase/migrations/existing.sql'), 'select 1;');
  symlinkSync(join(root, '.env.local'), join(root, 'secret-alias'));
  symlinkSync(other, join(root, 'outside'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe('Codex patch boundary', () => {
  it('checks every file in a mixed patch before allowing any edit', async () => {
    const result = await check(
      patch('*** Add File: safe.ts\n+export {};\n*** Add File: .env.local\n+FAKE=test'),
    );
    expect(result.decision).toBe('block');
  });
  it.each([
    '*** Delete File: .env.local',
    '*** Update File: safe.ts\n*** Move to: .env.local\n@@\n-x\n+y',
    '*** Update File: .env.local\n*** Move to: safe.ts\n@@\n-x\n+y',
    '*** Add File: secret-alias\n+FAKE=test',
    '*** Add File: outside/new/deep/file.txt\n+test',
    '*** Update File: supabase/migrations/existing.sql\n@@\n-select 1;\n+select 2;',
    '*** Delete File: supabase/migrations/existing.sql',
    '*** Add File: .op-env.agent\n+TOKEN=op://human/item/field',
    '*** Update File: .op-env.human\n*** Move to: .op-env.agent\n@@\n X=op://human/item/field',
    '*** Add File: ../escape.txt\n+test',
  ])('blocks protected or escaping operation %s', async (body) => {
    expect((await check(patch(body))).decision).toBe('block');
  });
  it('allows normal multifile edits and a rename', async () => {
    expect(
      (
        await check(
          patch(
            '*** Add File: a.ts\n+export {};\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-old\n+new\n*** Delete File: d.ts',
          ),
        )
      ).decision,
    ).toBe('allow');
  });
  it('allows new migrations and agent vault references', async () => {
    expect(
      (
        await check(
          patch(
            '*** Add File: supabase/migrations/new.sql\n+select 1;\n*** Add File: .op-env.agent\n+TOKEN=op://agent/item/field',
          ),
        )
      ).decision,
    ).toBe('allow');
  });
  it('resolves relative edits from a subdirectory', async () => {
    const result = await evaluateCodex(
      JSON.stringify({
        cwd: join(root, 'supabase'),
        tool_name: 'apply_patch',
        tool_input: { command: patch('*** Add File: migrations/new.sql\n+select 1;') },
      }),
    );
    expect(result.decision).toBe('allow');
  });
  it.each([
    '',
    '*** Begin Patch\n*** Move to: evil\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\nunsupported\n*** End Patch',
  ])('rejects malformed patch', (body) => {
    expect(() => parsePatch(body)).toThrow();
  });
});

describe('Codex shell and loader', () => {
  it.each([
    'git push --force',
    'git commit --no-verify',
    'op read op://agent/item/field',
    'cat .env.local',
    'cat supabase/.env.test',
    'cat supabase/.env*',
    'cat "./.env"',
    'op run --env-file=.op-env.human -- true',
  ])('blocks %s without execution', async (command) => {
    const result = await evaluateCodex(
      JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command } }),
    );
    expect(result.decision).toBe('block');
  });
  it('allows a normal exec_command', async () => {
    expect(
      (
        await evaluateCodex(
          JSON.stringify({
            cwd: root,
            tool_name: 'exec_command',
            tool_input: { cmd: 'git status --short' },
          }),
        )
      ).decision,
    ).toBe('allow');
  });
  it.each(['{}', 'invalid', '{"tool_name":"Bash","tool_input":{}}'])(
    'loader fails closed for %s',
    (input) => {
      const result = spawnSync('bash', [loader], { cwd: root, input, encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('BLOCKED');
    },
  );
  it('does not echo rejected command values', () => {
    const result = spawnSync('bash', [loader], {
      cwd: root,
      input: JSON.stringify({
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'git push --force FAKE_PRIVATE_VALUE' },
      }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain('FAKE_PRIVATE_VALUE');
  });
  it('checks the actual configured launcher, not just the evaluator', () => {
    const config = JSON.parse(readFileSync(resolve('.codex/hooks.json'), 'utf8'));
    expect(config.hooks.PreToolUse[0].matcher).toBe('.*');
    const command = config.hooks.PreToolUse[0].hooks[0].command;
    const result = spawnSync('bash', ['-c', command], {
      cwd: resolve('scripts'),
      input: JSON.stringify({
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
      }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    const allowed = spawnSync('bash', ['-c', command], {
      cwd: resolve('scripts'),
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
      }),
    });
    expect(allowed.status).toBe(0);
  });
});

describe('Codex delegation boundary', () => {
  it.each(['spawn_agent', 'collaboration.spawn_agent'])(
    'blocks explicit read-only %s because its scope is unobservable',
    async (tool_name) => {
      const result = await evaluateCodex(
        JSON.stringify({
          cwd: root,
          tool_name,
          tool_input: { readOnly: true, task: 'inspect files' },
        }),
      );
      expect(result).toMatchObject({
        decision: 'block',
        message: expect.stringContaining('親担当'),
      });
    },
  );

  it.each(['spawn_agent', 'collaboration.spawn_agent'])(
    'allows an explicit write/browser %s path to remain available',
    async (tool_name) => {
      const result = await evaluateCodex(
        JSON.stringify({
          cwd: root,
          tool_name,
          tool_input: { mode: 'write', task: 'implement the scoped change' },
        }),
      );
      expect(result).toEqual({ decision: 'allow' });
    },
  );
});

it('validates env references in the actual per-command workdir', async () => {
  const nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(root, '.op-env.agent'), 'TOKEN=op://agent/item/field');
  writeFileSync(join(nested, '.op-env.agent'), 'TOKEN=op://human/item/field');
  const command = 'op run --env-file=.op-env.agent -- true';
  const result = await evaluateCodex(
    JSON.stringify({
      cwd: root,
      tool_name: 'exec_command',
      tool_input: { cmd: command, workdir: nested },
    }),
  );
  expect(result.decision).toBe('block');
});

it('blocks rename into a vault-reference destination through a symlink', async () => {
  symlinkSync(join(root, '.op-env.agent'), join(root, 'agent-alias'));
  expect(
    (
      await check(
        patch(
          '*** Update File: source.txt\n*** Move to: agent-alias\n@@\n TOKEN=op://human/item/field',
        ),
      )
    ).decision,
  ).toBe('block');
});
