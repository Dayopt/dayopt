import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

/**
 * installed layout を snapshot 内に複製し、workspace code へのリンクも snapshot へ向ける。
 * @param {string} source
 * @param {string} target
 * @param {string} root
 * @param {string} snapshot
 */
function copyWorkspaceDependencies(source, target, root, snapshot) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const destination = resolve(source, readlinkSync(from));
      const repoRelative = relative(root, destination);
      const withinRepo =
        !isAbsolute(repoRelative) && repoRelative !== '..' && !repoRelative.startsWith('../');
      symlinkSync(withinRepo ? relative(target, join(snapshot, repoRelative)) : destination, to);
    } else if (entry.isDirectory()) {
      copyWorkspaceDependencies(from, to, root, snapshot);
    } else {
      copyFileSync(from, to);
    }
  }
}

/** Git hookの環境を子worktreeへ持ち込まず、送信するcommit treeごとに通常docs:checkを実行する。 */
export function checkPushedDocuments(input, root = process.cwd()) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_CEILING_DIRECTORIES',
  ])
    delete env[key];
  const git = (args) =>
    execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  if (!input.trim()) throw new Error('push ref入力がありません');
  const shas = new Set();
  for (const line of input.split('\n').filter((value) => value.trim())) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 4 ||
      !/^[a-f0-9]{40}$/.test(fields[1]) ||
      !/^[a-f0-9]{40}$/.test(fields[3]) ||
      !fields[2].startsWith('refs/')
    )
      throw new Error('push ref入力が不正です');
    if (fields[2].startsWith('refs/heads/') && fields[1] !== '0'.repeat(40)) shas.add(fields[1]);
  }
  for (const sha of shas) {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    const temporary = mkdtempSync(join(tmpdir(), 'dayopt-push-docs-'));
    const snapshot = join(temporary, 'checkout');
    let added = false;
    try {
      git(['worktree', 'add', '--detach', snapshot, sha]);
      added = true;
      const dependencies = join(root, 'node_modules');
      if (existsSync(dependencies)) {
        const target = join(snapshot, 'node_modules');
        mkdirSync(target);
        for (const entry of readdirSync(dependencies)) {
          if (entry.startsWith('.pnpm-') && entry.includes('state')) continue;
          symlinkSync(join(dependencies, entry), join(target, entry));
        }
      }
      // TypeScript の生成図は app 固有の依存型も辿る。root だけでは Supabase 等の
      // 型が解決できず、同じ commit の MCP → DB 接点が欠落して drift と誤判定する。
      for (const group of ['apps', 'packages']) {
        const groupPath = join(snapshot, group);
        if (!existsSync(groupPath)) continue;
        for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
          if (!entry.isDirectory() || !existsSync(join(groupPath, entry.name, 'package.json')))
            continue;
          const installed = join(root, group, entry.name, 'node_modules');
          if (existsSync(installed)) {
            copyWorkspaceDependencies(
              installed,
              join(groupPath, entry.name, 'node_modules'),
              root,
              snapshot,
            );
          }
        }
      }
      console.log(`→ push文書検査: ${sha}`);
      const docsCheck = JSON.parse(readFileSync(join(snapshot, 'package.json'), 'utf8')).scripts?.[
        'docs:check'
      ];
      if (docsCheck !== 'tsx scripts/tasks/docs-guard/index.ts')
        throw new Error('docs:check の実行定義が変わりました');
      // packageManager指定と実行環境のpnpm版が異なると、snapshot内での起動時に
      // package manager切替・依存再配置が走り、非対話のpushで失敗することがある。
      // docs:checkの本体を同じcommitのインストール済みtsxから直接実行する。
      execFileSync(
        process.execPath,
        [
          join(snapshot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          'scripts/tasks/docs-guard/index.ts',
        ],
        { cwd: snapshot, env, stdio: 'inherit' },
      );
    } finally {
      // 登録解除に失敗した場合は証拠となるworktreeを保持し、成功扱いにしない。
      if (added) git(['worktree', 'remove', '--force', snapshot]);
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      checkPushedDocuments(input);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });
}
