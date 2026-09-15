import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  fetchPrFilenames,
  fetchPrFilesFromGit,
  fetchPrFilesWithStatus,
  findFsReadingProductTests,
  formatMigrationSafetyOutput,
  resolveDiffBase,
  resolveProductUnitScope,
  runMcpConformance,
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

  it('destructive な変更が無ければ通知不要として終了する', async () => {
    const writeStepSummaryImpl = vi.fn(async () => {});
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl: fetchOk([]),
      writeStepSummaryImpl,
    });
    expect(result.notify).toBe(false);
    expect(writeStepSummaryImpl).toHaveBeenCalledOnce();
  });

  // 回帰固定: runUnit() は GH_TOKEN を process.env から外したうえで
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
    const summaries: string[] = [];
    const writeStepSummaryImpl = vi.fn(async (markdown: string) => {
      summaries.push(markdown);
    });
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 1,
      fetchFilesImpl,
      writeStepSummaryImpl,
      gitFallbackImpl: vi.fn(() => null),
      sleepImpl: vi.fn(async () => {}),
    });
    expect(fetchFilesImpl).toHaveBeenCalledTimes(2); // 1 回だけ再試行
    expect(result).toEqual({
      results: [],
      notify: false,
      summary: '',
      skipped: true,
      coupled: false,
      undeterminable: true,
    });
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
      writeStepSummaryImpl: vi.fn(async () => {}),
      gitFallbackImpl,
      sleepImpl: vi.fn(async () => {}),
    });
    expect(gitFallbackImpl).not.toHaveBeenCalled();
    expect(result.coupled).toBe(false);
    expect(result.undeterminable).toBeUndefined();
  });

  // 通知（ラベル + コメント）は ci.yml の migration-notice job が行う（credential audit P2-6）。
  // この関数は通知が要るかと本文だけを返し、write 系の gh を呼ぶ注入点自体を持たない。
  // 通知の順序・再通知抑止・fork PR の fail open は scripts/__tests__/ci-token-isolation.test.ts
  // が migration-notice job の run script を偽 gh で実行して固定する。
  it('destructive な変更を検知したら notify: true と Step Summary と同じ本文を返す', async () => {
    const summaries: string[] = [];
    const result = await runMigrationSafety({
      repo: 'Dayopt/dayopt',
      prNumber: 7,
      fetchFilesImpl: fetchOk([
        { filename: 'supabase/migrations/20260101_x.sql', status: 'added' },
      ]),
      readFileImpl: vi.fn(() => 'DROP TABLE foo;'),
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
    });
    expect(result.notify).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.summary).toBe(summaries[0]);
    expect(result.summary).toContain('DROP TABLE');
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
      writeStepSummaryImpl: vi.fn(async () => {}),
    });
    expect(result.notify).toBe(false);
    expect(result.results).toEqual([]);
  });
});

describe('formatMigrationSafetyOutput', () => {
  const decode = (lines: string[]) => {
    const b64 = lines.find((line) => line.startsWith('migration_comment_b64='))!.slice(22);
    return Buffer.from(b64, 'base64').toString('utf8');
  };

  it('通知が要る時は true と、改行・delimiter 風の行を含む本文を 1 行の base64 で出す', () => {
    const summary =
      '## Migration safety\n\nEOF\nmigration_destructive=false\n日本語 `DROP TABLE`\n';
    const lines = formatMigrationSafetyOutput({ notify: true, summary });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('migration_destructive=true');
    expect(lines[1]).toMatch(/^migration_comment_b64=[A-Za-z0-9+/]+={0,2}$/);
    expect(decode(lines)).toBe(summary);
  });

  it.each([
    [{ notify: false, summary: '## Migration safety' }],
    [{ notify: true }],
    [{ notify: 'true', summary: 'x' }],
    [undefined],
  ])('通知不要・不完全な入力 %j は false と空本文', (safety) => {
    expect(formatMigrationSafetyOutput(safety as never)).toEqual([
      'migration_destructive=false',
      'migration_comment_b64=',
    ]);
  });
});

describe('runMigrationSafety — coupled migration（#2680）', () => {
  const mfaLockdown =
    'REVOKE ALL ON TABLE public.mfa_recovery_codes FROM anon, authenticated;\nDROP POLICY "x" ON public.mfa_recovery_codes;';

  it('縮小 migration と product runtime 変更が同一 PR なら coupled: true を返し、summary / comment 本文に Coupled 節を足す', async () => {
    const summaries: string[] = [];
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
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
    });
    expect(result.coupled).toBe(true);
    expect(result.coupling?.narrowing.map((f) => f.kind)).toEqual(['REVOKE', 'DROP_POLICY']);
    expect(summaries[0]).toContain('Coupled migration');
    expect(result.notify).toBe(true);
    expect(result.summary).toContain('Coupled migration');
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
      writeStepSummaryImpl: vi.fn(async (markdown: string) => {
        summaries.push(markdown);
      }),
    });
    expect(result.coupled).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(summaries[0]).not.toContain('Coupled migration');
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

describe('resolveProductUnitScope', () => {
  it('product の src / messages と無関係な path だけなら related に絞る', () => {
    const decision = resolveProductUnitScope({
      isPr: true,
      files: [
        'apps/product/src/features/calendar/lib/remaining.ts',
        'apps/product/messages/ja/calendar.json',
        'docs/engineering/testing.md',
        'apps/web/src/app/page.tsx',
        'supabase/migrations/20260914000000_x.sql',
        '.github/workflows/promote.yml',
      ],
    });
    expect(decision).toMatchObject({
      scope: 'related',
      targets: [
        'apps/product/src/features/calendar/lib/remaining.ts',
        'apps/product/messages/ja/calendar.json',
      ],
    });
  });

  it.each([
    ['packages/components/src/button.tsx', 'dist 経由で読むので graph で追えない'],
    ['apps/product/vitest.config.ts', '設定'],
    ['apps/product/src/lib/test/setup.ts', 'test setup'],
    ['apps/product/package.json', '依存'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['.github/actions/setup/action.yml', 'CI toolchain'],
    ['.github/workflows/ci.yml', 'unit job の配線'],
    ['scripts/ci/check.mjs', 'この判定自身'],
    ['tsconfig.base.json', '未知の root file'],
  ])('%s を含むと full（%s）', (file) => {
    const decision = resolveProductUnitScope({
      isPr: true,
      files: ['apps/product/src/a.ts', file],
    });
    expect(decision.scope).toBe('full');
    expect(decision.reason).toContain(file);
  });

  it('判定できない時は full に倒す', () => {
    expect(resolveProductUnitScope({ isPr: false, files: ['apps/product/src/a.ts'] }).scope).toBe(
      'full',
    );
    expect(resolveProductUnitScope({ isPr: true, files: null }).scope).toBe('full');
    expect(resolveProductUnitScope({ isPr: true, files: [] }).scope).toBe('full');
    expect(
      resolveProductUnitScope({
        isPr: true,
        files: Array.from({ length: 3000 }, (_, i) => `apps/product/src/f${i}.ts`),
      }).scope,
    ).toBe('full');
  });

  it('CI_UNIT_MODE=full は PR でも full（nightly と手動の逃げ道）', () => {
    expect(
      resolveProductUnitScope({ isPr: true, unitMode: 'full', files: ['apps/product/src/a.ts'] })
        .scope,
    ).toBe('full');
  });
});

describe('findFsReadingProductTests', () => {
  it('fs を読む unit test だけを apps/product 基準の path で返す（integration は除く）', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-tests-'));
    const write = (path: string, body: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    write('src/app/route-contract.test.ts', "import { readFileSync } from 'node:fs';\n");
    write('src/features/a/boundary.test.ts', "import { readdirSync } from 'fs';\n");
    write('src/features/a/pure.test.ts', "import { sum } from './sum';\n");
    write('src/features/a/view.test.tsx', "import { render } from '@testing-library/react';\n");
    write(
      'src/lib/test/integration/rls.integration.test.ts',
      "import { readFileSync } from 'node:fs';\n",
    );
    write('src/node_modules/x/y.test.ts', "import { readFileSync } from 'node:fs';\n");

    expect(findFsReadingProductTests({ productDir: root })).toEqual([
      'src/app/route-contract.test.ts',
      'src/features/a/boundary.test.ts',
    ]);
  });

  it('実 repo の契約 test（service role 境界）を拾う', () => {
    expect(findFsReadingProductTests()).toContain(
      'src/features/auth/server/service-role-auth-usage.test.ts',
    );
  });
});

describe('conformance in required CI unit job', () => {
  it('skips explicitly unrelated changes', () => {
    const execute = vi.fn();
    runMcpConformance('false', execute);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['true', undefined])('runs for %s and propagates a baseline failure', (affected) => {
    const execute = vi.fn(() => {
      throw new Error('unexpected protocol failure');
    });
    expect(() => runMcpConformance(affected, execute)).toThrow('unexpected protocol failure');
    expect(execute).toHaveBeenCalledWith('pnpm', [
      '--filter',
      '@dayopt/product',
      'test:mcp:conformance',
    ]);
  });
});
