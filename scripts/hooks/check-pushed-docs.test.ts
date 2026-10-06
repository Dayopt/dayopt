import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    JSON.stringify({ scripts: { 'docs:check': 'tsx scripts/tasks/docs-guard/index.ts' } }),
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(root, 'node_modules/tsx/dist'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/tsx/dist/cli.mjs'),
    "#!/usr/bin/env node\nimport {execFileSync} from 'node:child_process'; execFileSync(process.execPath, ['inspect.mjs'], {stdio: 'inherit'});",
  );
  chmodSync(join(root, 'node_modules/tsx/dist/cli.mjs'), 0o755);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../tsx/dist/cli.mjs', join(root, 'node_modules/.bin/tsx'));
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

it('snapshotのworkspace依存型を解決し、workspaceリンクが作業中のコードを参照しない', () => {
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(root, 'apps/product'), { recursive: true });
  mkdirSync(join(root, 'packages/shared'), { recursive: true });
  writeFileSync(
    join(root, 'apps/product/package.json'),
    JSON.stringify({ name: '@dayopt/product' }),
  );
  writeFileSync(
    join(root, 'packages/shared/package.json'),
    JSON.stringify({ name: '@dayopt/shared' }),
  );
  writeFileSync(join(root, 'packages/shared/value.txt'), 'committed');
  writeFileSync(
    join(root, 'inspect.mjs'),
    `
    import { readFileSync, realpathSync, lstatSync } from 'node:fs';
    import { join } from 'node:path';
    const modules = join(process.cwd(), 'apps/product/node_modules');
    if (lstatSync(modules).isSymbolicLink()) throw new Error('shared mutable modules directory');
    if (readFileSync(join(modules, 'dependency/value.txt'), 'utf8') !== 'installed') throw new Error('missing dependency');
    if (realpathSync(join(modules, '@dayopt/shared')) !== realpathSync('packages/shared')) throw new Error('wrong workspace');
    if (readFileSync(join(modules, '@dayopt/shared/value.txt'), 'utf8') !== 'committed') throw new Error('uncommitted code');
  `,
  );
  const good = commit('valid');
  mkdirSync(join(root, 'node_modules/dependency'), { recursive: true });
  writeFileSync(join(root, 'node_modules/dependency/value.txt'), 'installed');
  mkdirSync(join(root, 'apps/product/node_modules/@dayopt'), { recursive: true });
  symlinkSync(
    '../../../node_modules/dependency',
    join(root, 'apps/product/node_modules/dependency'),
  );
  // 絶対リンクでも snapshot の同じ workspace へ置き換える。
  symlinkSync(
    join(root, 'packages/shared'),
    join(root, 'apps/product/node_modules/@dayopt/shared'),
  );
  writeFileSync(join(root, 'packages/shared/value.txt'), 'uncommitted');
  const before = git('status', '--porcelain');
  expect(() => checkPushedDocuments(input(good), root)).not.toThrow();
  expect(readFileSync(join(root, 'packages/shared/value.txt'), 'utf8')).toBe('uncommitted');
  expect(readFileSync(join(root, 'node_modules/dependency/value.txt'), 'utf8')).toBe('installed');
  expect(git('status', '--porcelain')).toBe(before);
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
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
