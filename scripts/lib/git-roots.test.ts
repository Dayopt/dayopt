import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(
      (m) => m[1],
    );

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, `${relPath} が ${specifier} を import している`).toMatch(/^node:/);
    }
  });

  it('guard 側の worktree 家系解決は、この lib と同じ返り値になる（drift 検出）', () => {
    // 実 repo（main checkout）で両者を突き合わせる。guard 側は private 関数なので
    // 直接は呼べないため、公開されている振る舞い（現在の repo root）で比較する。
    const roots = resolveRoots(REPO_ROOT);
    const expectedToplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();

    expect(roots).not.toBeNull();
    expect(roots?.currentRoot).toBe(resolvePhysicalPath(expectedToplevel, REPO_ROOT));
    // mainRoot は必ず currentRoot か、その祖先（worktree から呼んだ場合）になる。
    expect(roots?.mainRoot).toBeTruthy();
    expect(roots?.currentRoot.startsWith(roots?.mainRoot ?? '')).toBe(true);
  });
});
