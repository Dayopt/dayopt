import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { evaluate } from '../hooks/pre-tool-guard-rules.mjs';
import { resolveMainCheckoutRoot, resolvePhysicalPath, resolveRoots } from './git-roots.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * git 応答の stub。実 filesystem を触らないよう realpath も注入する（fixture の
 * path は実在しないため、既定の fs.realpathSync だと全て空文字になる）。
 */
function makeGit(responses: Record<string, string>) {
  return vi.fn((_cmd: string, args: string[]) => {
    const key = args.join(' ');
    if (!(key in responses)) throw new Error(`unexpected git call: ${key}`);
    return responses[key];
  }) as unknown as typeof execFileSync;
}

/** 実在しない fixture path をそのまま返す realpath（symlink 解決なし）。 */
const identityRealpath = ((p: string) => p) as unknown as typeof import('node:fs').realpathSync;

const MAIN = '/repo';
const LANE = '/repo/.claude/worktrees/lane';

describe('resolveRoots', () => {
  it('main checkout では mainRoot が currentRoot と一致し、isMainCheckout が true', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': MAIN,
      'rev-parse --absolute-git-dir': `${MAIN}/.git`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${LANE}\nHEAD def\nbranch refs/heads/lane\n`,
    });

    const roots = resolveRoots(MAIN, git, { realpathImpl: identityRealpath });

    expect(roots).not.toBeNull();
    expect(roots?.currentRoot).toBe(MAIN);
    expect(roots?.isMainCheckout).toBe(true);
    expect(roots?.mainRoot).toBe(MAIN);
    expect(roots?.otherRoots).toEqual([LANE]);
  });

  it('worktree から呼んでも mainRoot は main checkout を指す（#2674 の本体）', () => {
    const git = makeGit({
      // worktree では --show-toplevel が worktree 自身を返す。これが #2674 の原因。
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${MAIN}/.git/worktrees/lane`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${LANE}\nHEAD def\nbranch refs/heads/lane\n`,
    });

    const roots = resolveRoots(LANE, git, { realpathImpl: identityRealpath });

    expect(roots?.currentRoot).toBe(LANE);
    expect(roots?.isMainCheckout).toBe(false);
    expect(roots?.mainRoot).toBe(MAIN);
    // 自分自身は otherRoots に入らない。
    expect(roots?.otherRoots).toEqual([MAIN]);
  });

  it('git が失敗する（非 git ディレクトリ）と null', () => {
    const git = vi.fn(() => {
      throw new Error('not a git repository');
    }) as unknown as typeof execFileSync;

    expect(resolveRoots('/tmp/x', git, { realpathImpl: identityRealpath })).toBeNull();
  });

  it('worktree list が取れない時、main checkout なら currentRoot を mainRoot にする', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': MAIN,
      'rev-parse --absolute-git-dir': `${MAIN}/.git`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': '',
    });

    expect(resolveRoots(MAIN, git, { realpathImpl: identityRealpath })?.mainRoot).toBe(MAIN);
  });

  it('worktree list が取れず main checkout でもない時は mainRoot を空にする（誤った path を返さない）', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${MAIN}/.git/worktrees/lane`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': '',
    });

    const roots = resolveRoots(LANE, git, { realpathImpl: identityRealpath });
    expect(roots?.mainRoot).toBe('');
    expect(resolveMainCheckoutRoot(LANE, git, { realpathImpl: identityRealpath })).toBeNull();
  });

  it('bare repo 家系では bare entry を main checkout と誤認しない', () => {
    // `git worktree list --porcelain` は bare repo を先頭 stanza に出し、path の
    // 次行に `bare` を置く。行単位で `worktree ` だけを拾うと `.git` ディレクトリを
    // main checkout と誤認し、誰の cwd とも一致しない prefix になる（ai-usage が
    // 黙って 0 件になり、non-null なので fallback も効かない）。
    const BARE = '/repo/bare.git';
    const git = makeGit({
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${BARE}/worktrees/lane`,
      'rev-parse --git-common-dir': BARE,
      'worktree list --porcelain': `worktree ${BARE}\nbare\n\nworktree ${LANE}\nHEAD abc\nbranch refs/heads/main\n`,
    });

    const roots = resolveRoots(LANE, git, { realpathImpl: identityRealpath });

    // bare ディレクトリは main 候補にしない。最初の非 bare stanza を採る。
    expect(roots?.mainRoot).toBe(LANE);
    expect(roots?.mainRoot).not.toBe(BARE);
  });

  it('main checkout の path が解決できない時は mainRoot を空にする（別 worktree へ昇格させない）', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${MAIN}/.git/worktrees/lane`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\n\nworktree ${LANE}\n`,
    });
    // main checkout だけ realpath に失敗する（消えた main checkout 等）。
    const realpathImpl = ((p: string) => {
      if (p === MAIN) throw new Error('ENOENT');
      return p;
    }) as unknown as typeof import('node:fs').realpathSync;

    const roots = resolveRoots(LANE, git, { realpathImpl });

    expect(roots?.mainRoot).toBe('');
    expect(resolveMainCheckoutRoot(LANE, git, { realpathImpl })).toBeNull();
  });

  it('--git-common-dir が相対 path でも main checkout 判定ができる', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': MAIN,
      'rev-parse --absolute-git-dir': `${MAIN}/.git`,
      // git は cwd 次第で相対 path（`.git`）を返す。
      'rev-parse --git-common-dir': '.git',
      'worktree list --porcelain': `worktree ${MAIN}\n`,
    });

    expect(resolveRoots(MAIN, git, { realpathImpl: identityRealpath })?.isMainCheckout).toBe(true);
  });
});

describe('resolveMainCheckoutRoot', () => {
  it('worktree からでも main checkout の root を返す', () => {
    const git = makeGit({
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${MAIN}/.git/worktrees/lane`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\n\nworktree ${LANE}\n`,
    });

    expect(resolveMainCheckoutRoot(LANE, git, { realpathImpl: identityRealpath })).toBe(MAIN);
  });
});

describe('resolvePhysicalPath', () => {
  it('相対 path は cwd 基準で解決する', () => {
    expect(resolvePhysicalPath('.git', MAIN, identityRealpath)).toBe(`${MAIN}/.git`);
  });

  it('空入力と realpath 失敗は空文字', () => {
    expect(resolvePhysicalPath('', MAIN, identityRealpath)).toBe('');
    expect(
      resolvePhysicalPath('/nope', MAIN, (() => {
        throw new Error('ENOENT');
      }) as unknown as typeof import('node:fs').realpathSync),
    ).toBe('');
  });
});

/**
 * #2674 手順 2 は「pre-tool-guard-rules.mjs もこの lib を import する」だったが、
 * guard 側には先に置かれた不変条件がある（rules が import してよいのは node 標準
 * ライブラリだけ。loader の復旧経路が rules ファイル自身への Write/Edit しか通さない
 * ため、repo 内 helper に依存すると壊れた時に直せなくなる）。共有はせず複製を残した
 * 判断をここで機械強制し、次に同じ変更を試みた人が test で気づけるようにする。
 */
describe('pre-tool-guard の import 不変条件（#2674 で共有しなかった理由）', () => {
  const guardFiles = ['scripts/hooks/pre-tool-guard.mjs', 'scripts/hooks/pre-tool-guard-rules.mjs'];

  it.each(guardFiles)('%s は node 標準ライブラリしか import しない', (relPath) => {
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    // 静的 `import x from 'y'` / 副作用 `import 'y'` / 動的 `import('y')` の 3 形すべてを
    // 見る（loader 自身が動的 import を使うので、静的形だけを見ると素通りする）。
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      // 同ディレクトリの相対 import（loader → rules）は復旧経路が覆うので許す。
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./');
      expect(allowed, `${relPath} が ${specifier} を import している`).toBe(true);
    }
  });

  it('guard 側の worktree 家系解決は、この lib と同じ root を見る（drift 検出）', () => {
    // 実 git fixture（main + 2 worktree）を組み、**両実装を同じ state に対して動かす**。
    // guard 側の resolveRoots は private だが、worktree 境界違反の BLOCKED メッセージが
    // `currentRoot` を含む（pre-tool-guard-rules.mjs の checkWorktreeBoundary）ので、
    // そこを突き合わせれば実装同士を比較できる。
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'git-roots-drift-')));
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    try {
      const mainDir = join(fixtureRoot, 'main');
      mkdirSync(mainDir);
      git(['init', '-q', '-b', 'main'], mainDir);
      git(['config', 'user.email', 't@example.com'], mainDir);
      git(['config', 'user.name', 'test'], mainDir);
      writeFileSync(join(mainDir, 'seed.txt'), 'x\n');
      git(['add', 'seed.txt'], mainDir);
      git(['commit', '-qm', 'init'], mainDir);

      const laneA = join(mainDir, '.claude', 'worktrees', 'laneA');
      const laneB = join(mainDir, '.claude', 'worktrees', 'laneB');
      git(['worktree', 'add', '-q', laneA, '-b', 'laneA'], mainDir);
      git(['worktree', 'add', '-q', laneB, '-b', 'laneB'], mainDir);

      // --- lib 側の見え方 ---
      const libRoots = resolveRoots(laneA);
      expect(libRoots?.currentRoot).toBe(realpathSync(laneA));
      expect(libRoots?.mainRoot).toBe(realpathSync(mainDir));
      expect(libRoots?.otherRoots).toContain(realpathSync(laneB));

      // --- guard 側の見え方（同じ fixture、同じ cwd）---
      const decision = evaluate(
        JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: join(laneB, 'seed.txt') },
        }),
        { cwd: laneA },
      );

      // laneA から laneB を編集しようとしているので block される。
      expect(decision.decision).not.toBe('allow');
      // BLOCKED メッセージが名指しする currentRoot が lib の currentRoot と一致する。
      expect(decision.message).toContain(libRoots?.currentRoot ?? '<unresolved>');

      // 自分の worktree 内なら通る（fail-open ではなく、境界判定が効いている証拠）。
      const allowed = evaluate(
        JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: join(laneA, 'seed.txt') },
        }),
        { cwd: laneA },
      );
      expect(allowed.decision).toBe('allow');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
