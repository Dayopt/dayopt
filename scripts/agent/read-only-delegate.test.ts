import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildChildEnv,
  buildInvocation,
  buildPrompt,
  parseArgs,
  runReadOnlyDelegate,
  validateScope,
  validateTask,
} from './read-only-delegate.mjs';

const root = resolve('.');

describe('read-only delegate runtime contract', () => {
  it('builds Codex Luna invocation with a real read-only sandbox', () => {
    const invocation = buildInvocation({
      provider: 'codex',
      root,
      head: 'a'.repeat(40),
      scopes: ['scripts/agent'],
      task: 'find the relevant entry points',
    });
    expect(invocation.command).toBe('codex');
    expect(invocation.args.slice(0, 2)).toEqual(['--ask-for-approval', 'untrusted']);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--model',
        'gpt-5.6-luna',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'untrusted',
        '--ephemeral',
      ]),
    );
    expect(invocation.args.filter((arg) => arg === '--cd')).toHaveLength(1);
    expect(invocation.args[invocation.args.indexOf('--cd') + 1]).toBe(root);
    expect(invocation.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation.prompt).toContain('Do not modify the repository.');
  });

  it('builds Claude Haiku invocation with only read tools and plan mode', () => {
    const invocation = buildInvocation({
      provider: 'claude',
      root,
      head: 'b'.repeat(40),
      scopes: ['docs'],
      task: 'classify these documents',
    });
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--model',
        'haiku',
        '--effort',
        'low',
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Glob,Grep',
        '--no-session-persistence',
      ]),
    );
    expect(invocation.args).not.toContain('--dangerously-skip-permissions');
  });

  it('keeps the output contract explicit and scopes the worker', () => {
    const prompt = buildPrompt({
      root,
      head: 'c'.repeat(40),
      scopes: ['scripts/agent'],
      task: 'locate the parser',
    });
    expect(prompt).toContain('Allowed scope (and no other repository paths): scripts/agent');
    expect(prompt).toContain('Scope checked:');
    expect(prompt).toContain('Facts (with file and symbol or line locations):');
    expect(prompt).toContain('Unknowns / not checked:');
  });

  it('passes only safe process variables and drops credential-shaped values', () => {
    expect(
      buildChildEnv({
        PATH: '/bin',
        HOME: '/tmp/home',
        CI: '1',
        GH_TOKEN: 'ghp_secret',
        OPENAI_API_KEY: 'sk-secret-value',
        ANTHROPIC_API_KEY: 'secret',
        NODE_OPTIONS: '--require evil',
        OTHER: 'value',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/tmp/home', CI: '1' });
  });

  it('rejects secret, absolute, escaping, missing, and outside-symlink scopes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dayopt-readonly-'));
    const outside = mkdtempSync(join(tmpdir(), 'dayopt-readonly-outside-'));
    try {
      mkdirSync(join(fixture, 'src'));
      writeFileSync(join(fixture, 'src/file.ts'), 'export {};');
      writeFileSync(join(fixture, '.env.local'), 'TOKEN=secret');
      symlinkSync(outside, join(fixture, 'outside'));
      expect(validateScope(['src'], fixture)).toEqual(['src']);
      for (const scope of [
        '.env.local',
        '.envrc',
        '.git',
        '/tmp',
        '../outside',
        'src/..',
        'missing',
        'outside',
      ]) {
        expect(() => validateScope([scope], fixture)).toThrow();
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects credential-shaped task values and unknown CLI options', () => {
    expect(() => validateTask('read op://agent/item/field')).toThrow();
    expect(() => parseArgs(['--provider', 'codex', '--scope', 'src', '--unknown', 'x'])).toThrow();
    expect(parseArgs(['--provider', 'codex', '--scope', 'src', '--task', 'inspect files'])).toEqual(
      {
        provider: 'codex',
        scopes: ['src'],
        task: 'inspect files',
      },
    );
  });

  it('returns child failure for parent fallback and redacts child output', () => {
    const spawnImpl = vi.fn().mockReturnValue({
      status: 23,
      stdout: 'found ghp_supersecret',
      stderr: 'failed',
      error: undefined,
    });
    const result = runReadOnlyDelegate({
      provider: 'codex',
      scopes: ['scripts/agent'],
      task: 'inspect the wrapper',
      spawnImpl,
    });
    expect(result.status).toBe(23);
    expect(result.stdout).toContain('[redacted-github-token]');
    expect(spawnImpl).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['--model', 'gpt-5.6-luna', '--sandbox', 'read-only']),
      expect.objectContaining({ cwd: root, shell: false, encoding: 'utf8' }),
    );
  });
});
