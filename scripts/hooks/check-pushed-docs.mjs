import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

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
      console.log(`→ push文書検査: ${sha}`);
      execFileSync('pnpm', ['docs:check'], { cwd: snapshot, env, stdio: 'inherit' });
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
