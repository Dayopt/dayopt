import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectGhIdentity,
  collectPreflight,
  parseGhAuthStatus,
  renderPreflight,
} from './agent-preflight.mjs';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-preflight-'));
  dirs.push(root);
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  writeFileSync(join(root, '.nvmrc'), '24');
  return root;
}
describe('agent preflight', () => {
  it('reports missing dependencies and hooks, never marks runtime hooks as active', () => {
    const root = fixture();
    const state = collectPreflight(root);
    expect(state.dependencies).toBe(false);
    expect(state.pnpmMatches).toBe(false);
    expect(state.expectedPnpm).toBe(null);
    expect(state.hooks['pre-push']).toBe(false);
    expect(state.readOnlyDelegation.wrapper).toBe(false);
    expect(state.readOnlyDelegation.native).toContain('unsupported');
    expect(renderPreflight(state)).toContain('commit / push 前に');
  });
  it('flags a Node.js mismatch independently of the test runner version', () => {
    const root = fixture();
    const currentMajor = Number(process.versions.node.split('.')[0]);
    writeFileSync(join(root, '.nvmrc'), `${currentMajor + 1}\n`);
    const state = collectPreflight(root);
    expect(state.nodeMatches).toBe(false);
  });
  it('uses the Corepack entrypoint when it is the only matching pnpm contract', () => {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), '{"packageManager":"pnpm@11.26.0"}\n');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const corepack = join(bin, 'corepack');
    writeFileSync(
      corepack,
      '#!/bin/sh\n[ "$1" = "pnpm" ] && [ "$2" = "--version" ] || exit 1\nprintf \'11.26.0\\n\'\n',
    );
    chmodSync(corepack, 0o755);
    const pnpm = join(bin, 'pnpm');
    writeFileSync(pnpm, "#!/bin/sh\nprintf '10.0.0\\n'\n");
    chmodSync(pnpm, 0o755);
    const git = join(bin, 'git');
    writeFileSync(
      git,
      '#!/bin/sh\ncase "$1 $2" in\n  "rev-parse --show-toplevel") pwd ;;\n  "status --short") exit 0 ;;\n  *) exit 1 ;;\nesac\n',
    );
    chmodSync(git, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const state = collectPreflight(root);
      expect(state.pnpm).toBe('11.26.0');
      expect(state.pnpmMatches).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
  it('uses repository root from a subdirectory and verifies configured hook files', () => {
    const root = fixture();
    for (const dir of [
      'src/deep',
      'node_modules/.pnpm',
      '.husky/_',
      '.agents/skills/routing',
      '.codex',
    ])
      mkdirSync(join(root, dir), { recursive: true });
    for (const name of ['pre-commit', 'pre-push']) {
      writeFileSync(join(root, '.husky/_', name), '#!/bin/sh\n');
      writeFileSync(join(root, '.husky', name), 'true\n');
    }
    writeFileSync(join(root, '.agents/skills/routing/SKILL.md'), 'test');
    writeFileSync(join(root, '.codex/hooks.json'), '{}');
    expect(spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root }).status).toBe(
      0,
    );
    const state = collectPreflight(join(root, 'src/deep'));
    expect(state.root).toBe(root.replace(/^\/var\//, '/private/var/'));
    expect(state.dependencies).toBe(true);
    expect(state.hooks['pre-push']).toBe(true);
    expect(state.skills).toBe(true);
    expect(state.codexHooks).toContain('unverified');
    expect(state.readOnlyDelegation.wrapper).toBe(false);
    expect(state.readOnlyDelegation.native).toContain('scope cannot be enforced');
    expect(renderPreflight(state)).toContain('Read-only delegation');
  });
  it('flags a User OAuth token (classic broad scopes) as an un-isolated gh identity', () => {
    // 監査 P1-1 の実測形。token 行は parse 対象にしない
    const statusText = [
      'github.com',
      '  ✓ Logged in to github.com account t3-nico (keyring)',
      '  - Active account: true',
      '  - Token: gho_****',
      "  - Token scopes: 'admin:org', 'delete_repo', 'gist', 'repo', 'workflow'",
    ].join('\n');
    expect(parseGhAuthStatus(statusText)).toEqual({
      account: 't3-nico',
      scopes: ['admin:org', 'delete_repo', 'gist', 'repo', 'workflow'],
    });
    const identity = collectGhIdentity({ env: {}, statusText });
    expect(identity.isolated).toBe(false);
    expect(identity.broadScopes).toEqual(['admin:org', 'delete_repo', 'repo', 'workflow']);
    const rendered = renderPreflight({ ...collectPreflight(fixture()), ghIdentity: identity });
    expect(rendered).toContain('gh が User の OAuth token（admin:org');
    expect(rendered).not.toContain('gho_');
  });
  it('treats a fine-grained PAT under GH_CONFIG_DIR as isolated and stays quiet', () => {
    const statusText = [
      'github.com',
      '  ✓ Logged in to github.com account t3-nico (/Users/x/.config/gh-agent/hosts.yml)',
      '  - Active account: true',
      '  - Token: github_pat_****',
      '  - Token scopes: none',
    ].join('\n');
    const identity = collectGhIdentity({
      env: { GH_CONFIG_DIR: '/Users/x/.config/gh-agent' },
      statusText,
    });
    expect(identity).toMatchObject({
      account: 't3-nico',
      scopes: [],
      broadScopes: [],
      isolated: true,
      configDir: '/Users/x/.config/gh-agent',
    });
    const rendered = renderPreflight({ ...collectPreflight(fixture()), ghIdentity: identity });
    expect(rendered).toContain('config: /Users/x/.config/gh-agent | scopes: none (fine-grained)');
    expect(rendered).not.toContain('gh が User の OAuth token');
  });
  it('reports an unauthenticated or absent gh without throwing', () => {
    expect(collectGhIdentity({ env: {}, ghPresent: false })).toMatchObject({
      account: null,
      isolated: false,
    });
    expect(
      collectGhIdentity({ env: {}, statusText: 'You are not logged into any GitHub hosts.' }),
    ).toMatchObject({ account: null, scopes: [] });
  });
  it('CLI exits nonzero on missing prerequisites and supports JSON', () => {
    const root = fixture();
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/tasks/agent-preflight.mjs'), '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).dependencies).toBe(false);
  });
});
