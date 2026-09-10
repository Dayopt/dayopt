import { describe, expect, it, vi } from 'vitest';

import {
  fetchPrFilenames,
  fetchPrFilesFromGit,
  fetchPrFilesWithStatus,
  resolveDiffBase,
  runMigrationSafety,
  shouldRunIntegrationTests,
  shouldRunProductUnitTests,
  shouldRunStaticLanes,
} from './check.mjs';

/**
 * scripts/ci/check.mjs は `.github/workflows/ci.yml` から呼ばれる CI 実行本体
 * （#2483 Phase 1）。実コマンド（pnpm / gitleaks / gh api 実行）を伴う
 * `runStatic` / `runTest` 全体はここでは検証しない — この PR 自身が新しい
 * ci.yml で実走することが実地検証にあたる（PR 本文に実測ログを記載する）。
 * ここでは affected 判定・fail-open 分岐など、DI で外部呼び出しを差し替えられる
 * 純粋なロジックだけを固定する。
 */

describe('shouldRunStaticLanes', () => {
  it('docsOnly=true（boolean）なら static lane を skip する', () => {
    expect(shouldRunStaticLanes(true)).toBe(false);
  });
  it("docsOnly='true'（GITHUB_OUTPUT 由来の文字列）なら skip する", () => {
    expect(shouldRunStaticLanes('true')).toBe(false);
  });
  it('docsOnly=false / undefined なら実行する', () => {
    expect(shouldRunStaticLanes(false)).toBe(true);
    expect(shouldRunStaticLanes(undefined)).toBe(true);
  });
});

describe('shouldRunProductUnitTests', () => {
  it("productUnit=false / 'false' なら skip する", () => {
    expect(shouldRunProductUnitTests(false)).toBe(false);
    expect(shouldRunProductUnitTests('false')).toBe(false);
  });
  it('productUnit=true / undefined（判定不能）なら実行する（fail closed = 実行側）', () => {
    expect(shouldRunProductUnitTests(true)).toBe(true);
    expect(shouldRunProductUnitTests(undefined)).toBe(true);
  });
});

describe('shouldRunIntegrationTests', () => {
  it("integrationAffected=false / 'false' なら skip する", () => {
    expect(shouldRunIntegrationTests(false)).toBe(false);
    expect(shouldRunIntegrationTests('false')).toBe(false);
  });
  it('integrationAffected=true / undefined（判定不能）なら実行する（fail closed = 実行側）', () => {
    expect(shouldRunIntegrationTests(true)).toBe(true);
    expect(shouldRunIntegrationTests(undefined)).toBe(true);
  });
});

describe('resolveDiffBase', () => {
  it('candidate が存在すればそのまま使う', () => {
    const execImpl = vi.fn(() => ({ status: 0 }));
    expect(resolveDiffBase({ candidate: 'abc123', execImpl })).toBe('abc123');
    expect(execImpl).toHaveBeenCalledWith('git', ['cat-file', '-e', 'abc123'], expect.anything());
  });

  it('candidate が存在しなければ HEAD~1 へフォールバックする', () => {
    const execImpl = vi.fn((_cmd: string, args: string[]) =>
      args.includes('HEAD~1') ? { status: 0 } : { status: 1 },
    );
    expect(resolveDiffBase({ candidate: 'missing-sha', execImpl })).toBe('HEAD~1');
  });

  it('candidate も HEAD~1 も無ければ HEAD へフォールバックする（shallow clone 等）', () => {
    const execImpl = vi.fn(() => ({ status: 1 }));
    expect(resolveDiffBase({ candidate: '', execImpl })).toBe('HEAD');
  });

  it('candidate 未指定でも同じ規約で解決する', () => {
    const execImpl = vi.fn(() => ({ status: 0 }));
    expect(resolveDiffBase({ execImpl })).toBe('HEAD~1');
  });
});

describe('fetchPrFilenames', () => {
  it('pull_request context が無ければ空配列を返す（gh を呼ばない）', () => {
    const execImpl = vi.fn();
    expect(fetchPrFilenames({ execImpl })).toEqual([]);
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('gh api の出力を改行区切りで配列化する', () => {
    const execImpl = vi.fn(() => 'apps/product/src/foo.ts\napps/web/src/bar.ts\n');
    const files = fetchPrFilenames({ repo: 'Dayopt/dayopt', prNumber: 42, execImpl });
    expect(files).toEqual(['apps/product/src/foo.ts', 'apps/web/src/bar.ts']);
    expect(execImpl).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['api', '--paginate', 'repos/Dayopt/dayopt/pulls/42/files']),
      expect.anything(),
    );
  });
});

describe('fetchPrFilesWithStatus', () => {
  it('pull_request context が無ければ空配列を返す', () => {
    const execImpl = vi.fn();
    expect(fetchPrFilesWithStatus({ execImpl })).toEqual([]);
  });

  it('env を渡すと gh の実行 env として使う', () => {
    const execImpl = vi.fn(() => '');
    const env = { ...process.env, GH_TOKEN: 'token-for-gh' };
    fetchPrFilesWithStatus({ repo: 'Dayopt/dayopt', prNumber: 1, execImpl, env });
    expect(execImpl).toHaveBeenCalledWith(
      'gh',
      expect.anything(),
      expect.objectContaining({ env }),
    );
  });

  it('env を省略したら execImpl の options に env を渡さない（process.env を継承する）', () => {
    const execImpl = vi.fn(() => '');
    fetchPrFilesWithStatus({ repo: 'Dayopt/dayopt', prNumber: 1, execImpl });
    expect(execImpl).toHaveBeenCalledWith(
      'gh',
      expect.anything(),
      expect.not.objectContaining({ env: expect.anything() }),
    );
  });

  it('NDJSON を 1 行ずつ JSON.parse して配列化し、壊れた行はスキップする', () => {
    const execImpl = vi.fn(
      () =>
        '{"filename":"supabase/migrations/x.sql","status":"added"}\nnot-json\n{"filename":"a.ts","status":"modified"}\n',
    );
    const files = fetchPrFilesWithStatus({ repo: 'Dayopt/dayopt', prNumber: 1, execImpl });
    expect(files).toEqual([
      { filename: 'supabase/migrations/x.sql', status: 'added' },
      { filename: 'a.ts', status: 'modified' },
    ]);
  });
});

describe('runMigrationSafety', () => {
  const fetchOk = (entries: { filename: string; status: string }[]) => vi.fn(() => entries);
  const noopSpawn = () => ({ status: 0 });

  it('destructive な変更が無ければ通知せず終了する', async () => {
    const execFileImpl = vi.fn();
    const spawnImpl = vi.fn(noopSpawn);
    const writeStepSummaryImpl = vi.fn(async () => {});
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl: fetchOk([]),
      execFileImpl,
      spawnImpl,
      writeStepSummaryImpl,
    });
    expect(result.notified).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(writeStepSummaryImpl).toHaveBeenCalledOnce();
  });

  // 回帰固定: runTest() は write 権限つき GH_TOKEN を process.env から外したうえで
  // token を含む env を runMigrationSafety へ渡す。その env をファイル一覧取得の
  // gh 呼び出しへ転送し忘れると、gh が「GH_TOKEN を設定してください」で失敗し
  // Unit Tests job ごと落ちる（PR #2484 の実障害。run 33181021085）。
  it('渡された env をファイル一覧取得の gh 呼び出しへ転送する', async () => {
    const fetchFilesImpl = vi.fn(() => []);
    const env = { ...process.env, GH_TOKEN: 'token-for-gh' };
    await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl,
      execFileImpl: vi.fn(),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async () => {}),
      env,
    });
    expect(fetchFilesImpl).toHaveBeenCalledWith(expect.objectContaining({ env }));
  });

  // 回帰固定: ファイル一覧の取得失敗で job ごと落とさない（fail open）。
  // #2483 で migration safety を unit test 群より前へ移したため、ここで例外を
  // 素通しすると GitHub API の一時障害だけでテストが 1 本も走らなくなる。
  it('ファイル一覧の取得に失敗したら再試行 → git diff で代替し、どちらも駄目なら例外は投げず undeterminable を返す', async () => {
    const fetchFilesImpl = vi.fn(() => {
      throw new Error('gh api failed: 503');
    });
    const spawnImpl = vi.fn(noopSpawn);
    const summaries: string[] = [];
    const writeStepSummaryImpl = vi.fn(async (markdown: string) => {
      summaries.push(markdown);
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl,
      execFileImpl: vi.fn(),
      spawnImpl,
      writeStepSummaryImpl,
      gitFallbackImpl: vi.fn(() => null),
      sleepImpl: vi.fn(async () => {}),
    });
    expect(fetchFilesImpl).toHaveBeenCalledTimes(2); // 1 回だけ再試行
    expect(result).toEqual({
      results: [],
      notified: false,
      skipped: true,
      coupled: false,
      undeterminable: true,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(summaries[0]).toContain('判定ができません');
    expect(summaries[0]).toContain('gh api failed: 503');
  });

  it('gh api が 2 回失敗しても git diff で代替できれば coupled 判定まで行う', async () => {
    const fetchFilesImpl = vi.fn(() => {
      throw new Error('gh api failed: 503');
    });
    const summaries: string[] = [];
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl,
      readFileImpl: vi.fn(() => 'REVOKE ALL ON TABLE public.plans FROM authenticated;'),
      execFileImpl: vi.fn(() => 'false'),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
      gitFallbackImpl: vi.fn(() => [
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
        { filename: 'apps/product/src/a.ts', status: 'modified' },
      ]),
      sleepImpl: vi.fn(async () => {}),
    });
    expect(result.undeterminable).toBeUndefined();
    expect(result.coupled).toBe(true);
    expect(summaries[0]).toContain('git diff で代替');
  });

  it('gh api の再試行が成功したら fallback を使わない', async () => {
    let calls = 0;
    const fetchFilesImpl = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('gh api failed: 502');
      return [];
    });
    const gitFallbackImpl = vi.fn(() => null);
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl,
      execFileImpl: vi.fn(),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async () => {}),
      gitFallbackImpl,
      sleepImpl: vi.fn(async () => {}),
    });
    expect(gitFallbackImpl).not.toHaveBeenCalled();
    expect(result.coupled).toBe(false);
    expect(result.undeterminable).toBeUndefined();
  });

  it('destructive な変更を検知したら comment 投稿→ラベル付与の順で通知する', async () => {
    const readFileImpl = vi.fn(() => 'DROP TABLE foo;');
    const execFileImpl = vi.fn(() => 'false'); // has_label=false
    const calls: string[][] = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return { status: 0 };
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      ]),
      readFileImpl,
      execFileImpl,
      spawnImpl,
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(true);
    expect(result.results).toHaveLength(1);
    // label create → comment → label 付与の順で呼ばれる
    expect(calls[0]).toEqual(expect.arrayContaining(['label', 'create']));
    expect(calls[1]).toEqual(expect.arrayContaining(['pr', 'comment']));
    expect(calls[2]).toEqual(expect.arrayContaining(['api', '--method', 'POST']));
  });

  it('既にラベルが付いていれば round ごとに再通知しない', async () => {
    const execFileImpl = vi.fn(() => 'true'); // has_label=true
    const spawnImpl = vi.fn(noopSpawn);
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      ]),
      readFileImpl: vi.fn(() => 'DROP TABLE foo;'),
      execFileImpl,
      spawnImpl,
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('ラベル存在確認の gh api が失敗しても fail open で通知を試みる', async () => {
    const execFileImpl = vi.fn(() => {
      throw new Error('gh api rate limited');
    });
    const calls: string[][] = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return { status: 0 };
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      ]),
      readFileImpl: vi.fn(() => 'TRUNCATE foo;'),
      execFileImpl,
      spawnImpl,
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(true);
    expect(calls.some((c) => c.includes('comment'))).toBe(true);
  });

  it('コメント投稿が失敗（fork PR の read-only token 等）したらラベルは付与しない', async () => {
    const execFileImpl = vi.fn(() => 'false');
    const spawnImpl = vi.fn((_cmd: string, args: string[]) =>
      args.includes('comment') ? { status: 1 } : { status: 0 },
    );
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      ]),
      readFileImpl: vi.fn(() => 'DROP TABLE foo;'),
      execFileImpl,
      spawnImpl,
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(false);
    // label create は行うが、POST（ラベル付与）は行わない
    const postCalls = spawnImpl.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('POST'),
    );
    expect(postCalls).toHaveLength(0);
  });

  it('読めないファイル（削除・rename）は空文字として扱い例外を投げない', async () => {
    const readFileImpl = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([{ filename: 'supabase/migrations/removed.sql', status: 'removed' }]),
      readFileImpl,
      execFileImpl: vi.fn(),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(false);
    expect(result.results).toEqual([]);
  });
});

describe('runMigrationSafety — coupled migration（#2680）', () => {
  const noopSpawn = () => ({ status: 0 });
  const mfaLockdown =
    'REVOKE ALL ON TABLE public.mfa_recovery_codes FROM anon, authenticated;\nDROP POLICY "x" ON public.mfa_recovery_codes;';

  it('縮小 migration と product runtime 変更が同一 PR なら coupled: true を返し、summary / comment に Coupled 節を足す', async () => {
    const summaries: string[] = [];
    const bodies: string[] = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('comment')) bodies.push(args[args.length - 1] as string);
      return { status: 0 };
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: vi.fn(() => [
        { filename: 'supabase/migrations/20260908060000_lock_down.sql', status: 'added' },
        {
          filename: 'apps/product/src/features/settings/server/recovery-code-actions.ts',
          status: 'modified',
        },
      ]),
      readFileImpl: vi.fn(() => mfaLockdown),
      execFileImpl: vi.fn(() => 'false'),
      spawnImpl,
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
    });
    expect(result.coupled).toBe(true);
    expect(result.coupling?.narrowing.map((f) => f.kind)).toEqual(['REVOKE', 'DROP_POLICY']);
    expect(summaries[0]).toContain('Coupled migration');
    expect(bodies[0]).toContain('Coupled migration');
  });

  it('縮小 migration でも product runtime 変更が無ければ coupled: false（従来どおり fail open の通知のみ）', async () => {
    const summaries: string[] = [];
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: vi.fn(() => [
        { filename: 'supabase/migrations/20260908060000_lock_down.sql', status: 'added' },
        {
          filename: 'apps/product/src/lib/database/generated/database.types.ts',
          status: 'modified',
        },
        { filename: 'docs/engineering/infra.md', status: 'modified' },
      ]),
      readFileImpl: vi.fn(() => mfaLockdown),
      execFileImpl: vi.fn(() => 'false'),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
    });
    expect(result.coupled).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(summaries[0]).not.toContain('Coupled migration');
  });

  it('既にラベルが付いていて再通知しない round でも coupled は返す（hard fail は毎 push）', async () => {
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: vi.fn(() => [
        { filename: 'supabase/migrations/20260908060000_lock_down.sql', status: 'added' },
        { filename: 'apps/product/src/a.ts', status: 'modified' },
      ]),
      readFileImpl: vi.fn(() => mfaLockdown),
      execFileImpl: vi.fn(() => 'true'),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notified).toBe(false);
    expect(result.coupled).toBe(true);
  });

  it('destructive 無しなら coupled: false を返す', async () => {
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: vi.fn(() => [
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
        { filename: 'apps/product/src/a.ts', status: 'modified' },
      ]),
      readFileImpl: vi.fn(() => 'CREATE TABLE public.widgets (id uuid primary key);'),
      execFileImpl: vi.fn(),
      spawnImpl: vi.fn(noopSpawn),
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.coupled).toBe(false);
  });
});

describe('fetchPrFilesFromGit', () => {
  it('base ref があれば two-dot の name-status を {filename, status} に変換する', () => {
    const spawnImpl = vi.fn(() => ({ status: 0 }));
    const execFileImpl = vi.fn(
      () =>
        'A\tsupabase/migrations/20260101_x.sql\nM\tapps/product/src/a.ts\nR100\told.ts\tnew.ts\nD\tgone.ts\n',
    );
    expect(
      fetchPrFilesFromGit({ baseRef: 'origin/main', execImpl: execFileImpl, spawnImpl }),
    ).toEqual([
      { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      { filename: 'apps/product/src/a.ts', status: 'modified' },
      { filename: 'new.ts', status: 'renamed' },
      { filename: 'gone.ts', status: 'removed' },
    ]);
    expect(execFileImpl).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-status', '-M', 'origin/main', 'HEAD'],
      expect.anything(),
    );
  });

  it('base ref が無ければ depth=1 で fetch を試し、それでも無ければ null', () => {
    const calls: string[][] = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return { status: 1 };
    });
    expect(
      fetchPrFilesFromGit({ baseRef: 'origin/main', execImpl: vi.fn(), spawnImpl }),
    ).toBeNull();
    expect(calls.find((c) => c.includes('fetch'))).toEqual([
      'fetch',
      '--depth=1',
      'origin',
      'main:refs/remotes/origin/main',
    ]);
  });
});
