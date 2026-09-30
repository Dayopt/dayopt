import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkPushedDocuments } from './check-pushed-docs.mjs';
let root: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = (content: string) => {
  writeFileSync(join(root, 'README.md'), content);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
};
const input = (sha: string, branch = 'test') =>
  `HEAD ${sha} refs/heads/${branch} ${'0'.repeat(40)}\n`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-push-tree-'));
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'docs:check': 'node inspect.mjs' } }),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(
    join(root, 'inspect.mjs'),
    "import {readFileSync} from 'node:fs'; if(readFileSync('README.md','utf8').includes('invalid')) process.exit(19);",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('commit後にworking treeを直しても送信する違反treeを拒否し、未コミット作業を保持する', () => {
  const bad = commit('invalid');
  writeFileSync(join(root, 'README.md'), 'valid');
  const before = git('status', '--porcelain');
  expect(() => checkPushedDocuments(input(bad), root)).toThrow();
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('valid');
  expect(git('status', '--porcelain')).toBe(before);
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});
it('checkoutしていないbranchを含む全送信SHAを検査する', () => {
  const bad = commit('invalid');
  git('branch', 'other', bad);
  const good = commit('valid');
  expect(() => checkPushedDocuments(input(good, 'good') + input(bad, 'other'), root)).toThrow();
  expect(git('rev-parse', 'HEAD')).toBe(good);
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});
it('正しいcommitを通し、不明なSHAや不正入力は失敗させる', () => {
  const good = commit('valid');
  expect(() => checkPushedDocuments(input(good), root)).not.toThrow();
  expect(() => checkPushedDocuments(input('f'.repeat(40)), root)).toThrow();
  expect(() => checkPushedDocuments('malformed', root)).toThrow();
});

it('実pre-pushも作業中の修正で送信commitの違反を隠せない（hook環境はsnapshotへ継承しない）', () => {
  const repo = resolve(import.meta.dirname, '../..');
  mkdirSync(join(root, 'scripts/hooks'), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  copyFileSync(
    join(repo, 'scripts/hooks/check-pushed-docs.mjs'),
    join(root, 'scripts/hooks/check-pushed-docs.mjs'),
  );
  copyFileSync(
    join(repo, 'scripts/lib/is-direct-execution.mjs'),
    join(root, 'scripts/lib/is-direct-execution.mjs'),
  );
  const bad = commit('invalid');
  writeFileSync(join(root, 'README.md'), 'valid');
  const key = execFileSync('git', ['hash-object', '--stdin'], {
    cwd: root,
    input: `refs/heads/test ${bad}\n`,
    encoding: 'utf8',
  }).trim();
  mkdirSync(join(root, '.git/dayopt-push-confirm'), { recursive: true });
  writeFileSync(join(root, '.git/dayopt-push-confirm', key), '');
  const result = spawnSync('sh', [join(repo, '.husky/pre-push')], {
    cwd: root,
    input: input(bad),
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      GIT_DIR: join(root, '.git'),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, '.git/index'),
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain(`push文書検査: ${bad}`);
  expect(result.stderr).toContain('push対象commitの文書検査が失敗');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('valid');
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});
