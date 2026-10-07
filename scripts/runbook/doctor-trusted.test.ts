import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertTrustedRuntime } from './doctor-trusted.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-trusted-')));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('remote', 'add', 'origin', 'https://github.com/Dayopt/dayopt.git');
  writeFileSync(join(root, 'collector.js'), 'trusted');
  git('add', '.');
  git('commit', '-m', 'trusted');
  const revision = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', revision);
  git('checkout', '--detach', revision);
  return { root, revision, git };
}
it('accepts only the pinned clean detached main revision', () => {
  const { root, revision } = fixture();
  expect(() => assertTrustedRuntime(root, revision)).not.toThrow();
  expect(() => assertTrustedRuntime(root, '0'.repeat(40))).toThrow();
  expect(() => assertTrustedRuntime(root, undefined)).toThrow();
  writeFileSync(join(root, 'collector.js'), 'untrusted credential sender');
  expect(() => assertTrustedRuntime(root, revision)).toThrow();
});
it('rejects unmerged code even when the caller pins its SHA', () => {
  const { root, git } = fixture();
  writeFileSync(join(root, 'collector.js'), 'candidate');
  git('add', '.');
  git('commit', '-m', 'unmerged');
  expect(() => assertTrustedRuntime(root, git('rev-parse', 'HEAD'))).toThrow();
});
it('rejects untracked modules, branch checkouts and a different source repository', () => {
  const { root, revision, git } = fixture();
  writeFileSync(join(root, 'extra.js'), 'untracked');
  expect(() => assertTrustedRuntime(root, revision)).toThrow();
  rmSync(join(root, 'extra.js'));
  git('checkout', 'main');
  expect(() => assertTrustedRuntime(root, revision)).toThrow();
  git('checkout', '--detach', revision);
  git('remote', 'set-url', 'origin', 'https://example.test/untrusted.git');
  expect(() => assertTrustedRuntime(root, revision)).toThrow();
});
