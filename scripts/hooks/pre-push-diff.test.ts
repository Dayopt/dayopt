import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  isBranchUpdate,
  parseRefUpdates,
  refHasTrackedDiff,
  shouldSkipDoConfirm,
} from './pre-push-diff.mjs';

const ZERO = '0000000000000000000000000000000000000000';

describe('ローカル / リモート共通の文書検査', () => {
  it.each(['manual', 'push'] as const)(
    '%s 経路で文書違反があれば後続の検査へ進まず失敗する',
    (entry) => {
      const result = runDocumentationPreflight(entry, true);
      expect(result.status).not.toBe(0);
      expect(result.trace).toContain('pnpm docs:check');
      expect(result.trace).not.toContain('pnpm typecheck');
      expect(result.trace).not.toContain('npx turbo');
    },
  );
  it.each(['manual', 'push'] as const)('%s 経路で文書検査成功後に従来の検査を続ける', (entry) => {
    const result = runDocumentationPreflight(entry, false);
    expect(result.status).toBe(0);
    expect(result.trace).toContain('pnpm docs:check');
    expect(result.trace).toContain(
      entry === 'manual' ? 'pnpm typecheck' : 'pnpm typecheck:scripts',
    );
  });
});

function runDocumentationPreflight(entry: 'manual' | 'push', fail: boolean) {
  const repo = resolve(import.meta.dirname, '../..');
  const root = mkdtempSync(join(tmpdir(), 'dayopt-doc-preflight-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, '.git/dayopt-push-confirm'), { recursive: true });
    writeFileSync(join(root, '.git/dayopt-push-confirm/confirmed'), '');
    const scripts: Record<string, string> = {
      pnpm: 'printf "pnpm %s\\n" "$*" >> "$DOC_PREFLIGHT_TRACE"\nif [ "$1" = "docs:check" ] && [ "$DOC_PREFLIGHT_FAIL" = "1" ]; then exit 19; fi\nexit 0',
      git: 'case "$1" in rev-parse) echo .git ;; hash-object) cat >/dev/null; echo confirmed ;; *) exit 1 ;; esac',
      node: 'echo no-skip',
      npx: 'printf "npx %s\\n" "$*" >> "$DOC_PREFLIGHT_TRACE"\necho "{}"',
      jq: 'cat >/dev/null; echo 0',
    };
    for (const [name, body] of Object.entries(scripts))
      writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    const command =
      entry === 'manual'
        ? ['-c', JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.check]
        : [join(repo, '.husky/pre-push')];
    const trace = join(root, 'trace');
    writeFileSync(trace, '');
    const result = spawnSync('sh', command, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CI: '1',
        DOC_PREFLIGHT_TRACE: trace,
        DOC_PREFLIGHT_FAIL: fail ? '1' : '0',
      },
      input:
        'refs/heads/test 1111111111111111111111111111111111111111 refs/heads/test 0000000000000000000000000000000000000000\n',
      encoding: 'utf8',
      timeout: 10000,
    });
    return { status: result.status, trace: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('parseRefUpdates', () => {
  it('git pre-push hook の stdin 形式を1行ずつパースする', () => {
    expect(
      parseRefUpdates(
        'refs/heads/foo sha1 refs/heads/foo remoteSha1\nrefs/heads/bar sha2 refs/heads/bar remoteSha2\n',
      ),
    ).toEqual([
      {
        localRef: 'refs/heads/foo',
        localSha: 'sha1',
        remoteRef: 'refs/heads/foo',
        remoteSha: 'remoteSha1',
      },
      {
        localRef: 'refs/heads/bar',
        localSha: 'sha2',
        remoteRef: 'refs/heads/bar',
        remoteSha: 'remoteSha2',
      },
    ]);
  });

  it('空行・前後の空白を無視する', () => {
    expect(parseRefUpdates('\n  refs/heads/foo sha1 refs/heads/foo remoteSha1  \n\n')).toEqual([
      {
        localRef: 'refs/heads/foo',
        localSha: 'sha1',
        remoteRef: 'refs/heads/foo',
        remoteSha: 'remoteSha1',
      },
    ]);
  });

  it('入力が空文字なら空配列', () => {
    expect(parseRefUpdates('')).toEqual([]);
  });
});

describe('isBranchUpdate', () => {
  it('branch 更新（非ZERO local sha + refs/heads/*）は true', () => {
    expect(isBranchUpdate({ localSha: 'abc123', remoteRef: 'refs/heads/main' })).toBe(true);
  });

  it('branch 削除（local sha が ZERO）は false', () => {
    expect(isBranchUpdate({ localSha: ZERO, remoteRef: 'refs/heads/main' })).toBe(false);
  });

  it('tag push は false', () => {
    expect(isBranchUpdate({ localSha: 'abc123', remoteRef: 'refs/tags/v1.0.0' })).toBe(false);
  });
});

describe('refHasTrackedDiff', () => {
  it('remoteSha が非ZERO で全commitが空なら false（差分なし）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'c1\nc2\n';
      if (args[0] === 'diff') return ''; // exit 0 (差分なし)
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      false,
    );
  });

  // push前反証レビュー指摘（P3、PR #2445）: per-commit判定だけでは force-push の
  // 穴が残る。remote の C を落として同じ親から空コミット D を積む force-push
  // では rev-list C..D = {D}、D 自体は空のため per-commit 判定だけだと
  // 「差分なし」に誤判定される。実際には remote の tree が C の内容から
  // D（= C の親と同じ内容）へ後退しており、C が持っていた変更が消えるという
  // 実質的な差分がある。overall range diff（base..localSha）を AND で要求する
  // ことでこれを検出する。
  it('per-commitは空でもforce-pushで内容が後退していれば true（range diffとのAND）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'D\n';
      if (args[0] === 'diff') {
        // per-commit diff（D^ D）は空。だが overall range diff（C D）は
        // 実際には差分あり（force-pushでCの変更が失われるため）。
        if (args[2] === 'D^') return '';
        if (args[2] === 'C' && args[3] === 'D') throw new Error('exit 1: has diff');
        throw new Error(`unexpected diff call: ${args.join(' ')}`);
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'D', remoteSha: 'C' }, { execFileImpl })).toBe(true);
  });

  it('1件でも差分のあるcommitがあれば true（複数commit中の1件でも検出する）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'c1\nc2\nc3\n';
      if (args[0] === 'diff') {
        if (args[3] === 'c2') throw new Error('exit 1: has diff');
        return '';
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      true,
    );
  });

  // plan-review 指摘（plan-critic）: range全体のnet diffで判定すると、
  // 追加→削除で打ち消し合うcommit列が「差分なし」に誤判定される。
  // per-commit判定ならこのケースを正しく拾う。
  it('range全体では打ち消し合っても、個別commitに差分があれば true', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'c-add\nc-remove\n';
      if (args[0] === 'diff') {
        // c-add と c-remove はそれぞれ単体では差分を持つ（ファイル追加→削除）
        throw new Error('exit 1: has diff');
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      true,
    );
  });

  it('remoteSha が ZERO なら merge-base(origin/main, local) を base として解決する', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'merge-base') {
        expect(args.slice(1)).toEqual(['origin/main', 'local']);
        return 'merge-base-sha\n';
      }
      if (args[0] === 'rev-list') {
        expect(args[1]).toBe('merge-base-sha..local');
        return 'c1\n';
      }
      if (args[0] === 'diff') return '';
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: ZERO }, { execFileImpl })).toBe(false);
  });

  it('merge-base が解決できなければ true（安全側、skipしない）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('unknown revision');
      throw new Error('should not reach here');
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: ZERO }, { execFileImpl })).toBe(true);
  });

  // delta re-review 指摘（P2、PR #2445）: フォールバック base に origin/main の
  // 現在の tip を直接使うと、worktree 作成後に main が進むたび（本 repo は
  // 1日約7merge）に、branch自身は空コミットのみでも「main側で積まれた
  // 無関係な変更」までrange diffに混ざり、#2432のDoDが実運用でほぼ満たされ
  // なくなっていた。merge-base を使えば main の先行と無関係にbranch自身の
  // 追加分だけを見られることを固定する。
  it('origin/main がbranch分岐後に先行していても、branch自身が空コミットのみならskipされる', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'merge-base') {
        // origin/main は既に何本もmergeされ先行しているが、merge-baseは
        // このbranchが実際に分岐した古い時点を正しく返す。
        expect(args.slice(1)).toEqual(['origin/main', 'local']);
        return 'branch-point-sha\n';
      }
      if (args[0] === 'rev-list') {
        expect(args[1]).toBe('branch-point-sha..local');
        return 'empty-commit\n'; // branch自身の追加は空コミット1件のみ
      }
      if (args[0] === 'diff') return ''; // per-commit差分・range diffともに空
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: ZERO }, { execFileImpl })).toBe(false);
  });

  it('rev-list 自体が失敗すれば true（安全側）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') throw new Error('bad revision range');
      throw new Error('should not reach here');
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      true,
    );
  });

  it('commit一覧が空なら true（想定外の状態を安全側に倒す）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return '';
      throw new Error('should not reach here');
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      true,
    );
  });

  it('root commit（親が無い）で diff --quiet が失敗すれば true（安全側）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'root-commit\n';
      if (args[0] === 'diff') throw new Error('unknown revision root-commit^');
      throw new Error('should not reach here');
    });
    expect(refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl })).toBe(
      true,
    );
  });

  it('git diff がタイムアウト設定を渡される（hang対策）', () => {
    const execFileImpl = vi.fn((_file: string, _args: string[], options?: { timeout?: number }) => {
      expect(options?.timeout).toBeGreaterThan(0);
      if (_args[0] === 'rev-list') return 'c1\n';
      return '';
    });
    refHasTrackedDiff({ localSha: 'local', remoteSha: 'remote' }, { execFileImpl });
  });
});

describe('shouldSkipDoConfirm', () => {
  it('branch update が無ければ false', () => {
    expect(
      shouldSkipDoConfirm([
        { localRef: 'refs/tags/v1', localSha: 'x', remoteRef: 'refs/tags/v1', remoteSha: ZERO },
      ]),
    ).toBe(false);
  });

  it('全refが差分なしなら true（skip）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'c1\n';
      if (args[0] === 'diff') return '';
      throw new Error('unexpected');
    });
    const refUpdates = [
      { localRef: 'refs/heads/a', localSha: 'la', remoteRef: 'refs/heads/a', remoteSha: 'ra' },
    ];
    expect(shouldSkipDoConfirm(refUpdates, { execFileImpl })).toBe(true);
  });

  it('複数refのうち1つでも差分があれば false（混在pushはskipしない）', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') {
        return args[1].startsWith('ra..') ? 'c1\n' : 'c2\n';
      }
      if (args[0] === 'diff') {
        // b branch (rb..) 側の commit c2 に差分あり
        if (args[3] === 'c2') throw new Error('has diff');
        return '';
      }
      throw new Error('unexpected');
    });
    const refUpdates = [
      { localRef: 'refs/heads/a', localSha: 'la', remoteRef: 'refs/heads/a', remoteSha: 'ra' },
      { localRef: 'refs/heads/b', localSha: 'lb', remoteRef: 'refs/heads/b', remoteSha: 'rb' },
    ];
    expect(shouldSkipDoConfirm(refUpdates, { execFileImpl })).toBe(false);
  });

  it('単一refの中に空コミット+差分コミットが混在していれば false', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[0] === 'rev-list') return 'empty-commit\nreal-change-commit\n';
      if (args[0] === 'diff') {
        if (args[3] === 'real-change-commit') throw new Error('has diff');
        return '';
      }
      throw new Error('unexpected');
    });
    const refUpdates = [
      { localRef: 'refs/heads/a', localSha: 'la', remoteRef: 'refs/heads/a', remoteSha: 'ra' },
    ];
    expect(shouldSkipDoConfirm(refUpdates, { execFileImpl })).toBe(false);
  });
});
