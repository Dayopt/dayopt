import { describe, expect, it } from 'vitest';

import {
  checkFiles,
  detectContractNarrowing,
  detectDestructivePatterns,
  evaluateCoupledMigration,
  formatCoupledSummary,
  formatGithubOutput,
  formatSummary,
  isProductRuntimePath,
} from './check-destructive-migration.mjs';

describe('detectDestructivePatterns', () => {
  it('DROP TABLE を検知する', () => {
    const findings = detectDestructivePatterns('DROP TABLE public.legacy_tags;');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'DROP_TABLE', line: 1 });
  });

  it('DROP COLUMN を検知する', () => {
    const findings = detectDestructivePatterns('ALTER TABLE public.tags DROP COLUMN legacy_flag;');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'DROP_COLUMN' });
  });

  it('TRUNCATE を検知する', () => {
    const findings = detectDestructivePatterns('TRUNCATE public.stripe_webhook_events;');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'TRUNCATE' });
  });

  it('列の型変更(ALTER COLUMN ... TYPE)を検知する', () => {
    const findings = detectDestructivePatterns(
      'ALTER TABLE public.tags ALTER COLUMN name TYPE varchar(50);',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'ALTER_COLUMN_TYPE' });
  });

  it('SET DATA TYPE 構文も検知する', () => {
    const findings = detectDestructivePatterns(
      'ALTER TABLE public.tags ALTER COLUMN name SET DATA TYPE varchar(50);',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'ALTER_COLUMN_TYPE' });
  });

  it('DELETE FROM を検知する', () => {
    const findings = detectDestructivePatterns(
      'DELETE FROM public.tags WHERE archived_at IS NOT NULL;',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'DELETE_FROM' });
  });

  it('DROP POLICY を検知する', () => {
    const findings = detectDestructivePatterns(
      'DROP POLICY "Users can view own plans" ON public.plans;',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'DROP_POLICY' });
  });

  it('REVOKE を検知する', () => {
    const findings = detectDestructivePatterns('REVOKE SELECT ON public.tags FROM authenticated;');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'REVOKE' });
  });

  it.each(['RENAME COLUMN old_name TO new_name', 'RENAME TO new_table_name'])(
    'RENAME (%s) を検知する',
    (clause) => {
      const findings = detectDestructivePatterns(`ALTER TABLE public.tags ${clause};`);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind: 'RENAME' });
    },
  );

  it.each([
    ['DROP FUNCTION public.legacy_fn();', 'DROP_FUNCTION'],
    ['DROP TRIGGER legacy_trigger ON public.tags;', 'DROP_TRIGGER'],
    ['ALTER TABLE public.tags DROP CONSTRAINT legacy_check;', 'DROP_CONSTRAINT'],
  ])('%s を検知する', (sql, kind) => {
    const findings = detectDestructivePatterns(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind });
  });

  it('複数行に折り返された ALTER COLUMN ... TYPE も検知する（行単位マッチの穴を塞ぐ）', () => {
    const sql = [
      'ALTER TABLE public.tags',
      '  ALTER COLUMN very_long_column_name',
      '  TYPE varchar(50);',
    ].join('\n');
    const findings = detectDestructivePatterns(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'ALTER_COLUMN_TYPE' });
  });

  it('コメント行内の DROP には反応しない', () => {
    const findings = detectDestructivePatterns(
      '-- 過去に DROP TABLE を検討したが見送った\nCREATE TABLE public.new_table (id uuid primary key);',
    );
    expect(findings).toHaveLength(0);
  });

  it('通常の CREATE / ADD COLUMN 系には反応しない', () => {
    const findings = detectDestructivePatterns(
      'CREATE TABLE public.tags (id uuid primary key);\nALTER TABLE public.tags ADD COLUMN sort_order int NOT NULL DEFAULT 0;',
    );
    expect(findings).toHaveLength(0);
  });

  it('1ファイル内の複数検知を全て拾う（行番号付き）', () => {
    const sql = ['DROP TABLE public.a;', 'ALTER TABLE public.b DROP COLUMN c;'].join('\n');
    const findings = detectDestructivePatterns(sql);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'DROP_TABLE', line: 1 }),
      expect.objectContaining({ kind: 'DROP_COLUMN', line: 2 }),
    ]);
  });
});

describe('checkFiles', () => {
  it('status=added かつ supabase/migrations/ 配下のみを対象にする', () => {
    const results = checkFiles([
      {
        path: 'supabase/migrations/20260101000000_drop.sql',
        status: 'added',
        content: 'DROP TABLE x;',
      },
      // status が modified の既存ファイルは対象外（append-only 前提、ノイズ回避）
      {
        path: 'supabase/migrations/20260101000001_old.sql',
        status: 'modified',
        content: 'DROP TABLE y;',
      },
      // migrations 配下でないファイルは対象外
      { path: 'apps/product/src/foo.sql', status: 'added', content: 'DROP TABLE z;' },
      // migrations 配下でも非 SQL（ポインタ用 markdown 等）は対象外（#2510）
      {
        path: 'supabase/migrations/CLAUDE.md',
        status: 'added',
        content: 'DROP TABLE の説明を含む markdown',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('supabase/migrations/20260101000000_drop.sql');
  });

  it('破壊的パターンが無い新規 migration は結果に含めない', () => {
    const results = checkFiles([
      {
        path: 'supabase/migrations/20260101000002_add.sql',
        status: 'added',
        content: 'CREATE TABLE public.new_table (id uuid primary key);',
      },
    ]);
    expect(results).toEqual([]);
  });
});

/**
 * UPDATE backfill 検知（#2433、台帳 第2段）。
 *
 * 第8段（色再割当て等）が持ち込む UPDATE backfill は DROP と同じく forward-only なのに、
 * checker が検知していなかった（#2396 T6 で実測済みの fail-open）。
 *
 * この pattern の設計上の要は「関数本体の UPDATE を拾わないこと」と
 * 「`DO $$ ... $$` の匿名ブロックは拾うこと」の両立。前者を外すと事実上すべての
 * migration に発火して checker がノイズになり、後者を外すと backfill の書き方ひとつで
 * まるごと素通りする。**検知する側と通す側を両方固定する。**
 */
describe('detectDestructivePatterns — UPDATE backfill (#2433)', () => {
  const updateFindings = (sql: string) =>
    detectDestructivePatterns(sql).filter((f) => f.kind === 'UPDATE_BACKFILL');
  const backfillFindings = (sql: string) =>
    detectDestructivePatterns(sql).filter((f) => /BACKFILL$/.test(f.kind));

  describe('検知する（top-level の backfill）', () => {
    it.each([
      ['単純な UPDATE', "UPDATE public.categories SET color = 'blue' WHERE color = 'teal';"],
      ['複数行に折り返した UPDATE', 'UPDATE public.categories\n  SET color = null\n  WHERE true;'],
      ['別名つき UPDATE', 'UPDATE public.plans p SET title = 1;'],
      ['AS 別名つき UPDATE', 'UPDATE public.plans AS p SET title = 1;'],
      ['UPDATE ONLY', 'UPDATE ONLY public.plans SET title = 1;'],
      [
        '他 schema への UPDATE',
        "UPDATE storage.buckets SET public = false WHERE id = 'attachments';",
      ],
    ])('%s を検知する', (_name, sql) => {
      expect(updateFindings(sql)).toHaveLength(1);
    });

    // ここが素通りすると、backfill を `DO $$ ... $$` で包むだけで検知を回避できてしまう。
    it.each([
      ['タグなし DO ブロック', 'DO $$ BEGIN UPDATE public.categories SET color = 1; END $$;'],
      ['タグつき DO ブロック', 'DO $mig$ BEGIN UPDATE public.plans SET title = 2; END $mig$;'],
    ])('%s 内の backfill も検知する', (_name, sql) => {
      expect(updateFindings(sql)).toHaveLength(1);
    });
  });

  describe('通す（backfill ではないもの）', () => {
    it.each([
      [
        '関数本体の UPDATE（RPC のロジック）',
        'CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.plans SET title = 1; END; $$;',
      ],
      [
        'OR REPLACE 関数本体の UPDATE',
        'CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $fn$ BEGIN UPDATE public.plans SET x = 1; END $fn$ LANGUAGE plpgsql;',
      ],
      ['ON UPDATE CASCADE', 'ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u(b) ON UPDATE CASCADE;'],
      ['FOR UPDATE 行ロック', 'SELECT * FROM public.plans WHERE id = 1 FOR UPDATE;'],
      [
        'BEFORE UPDATE トリガー',
        'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.segments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();',
      ],
      ['FOR UPDATE ポリシー', 'CREATE POLICY p ON t FOR UPDATE USING (true) WITH CHECK (true);'],
      [
        'GRANT UPDATE',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.segments TO authenticated;',
      ],
      [
        "has_table_privilege の 'UPDATE' 文字列",
        "IF has_table_privilege('anon', t, 'UPDATE') THEN RAISE EXCEPTION 'x'; END IF;",
      ],
      ['SET DEFAULT', 'ALTER TABLE t ALTER COLUMN c SET DEFAULT now();'],
      ['コメント中の UPDATE 言及', '-- UPDATE public.plans SET title = 1;'],
    ])('%s は検知しない', (_name, sql) => {
      expect(updateFindings(sql)).toHaveLength(0);
    });
  });

  it('関数本体を潰しても行番号がずれない', () => {
    const sql = [
      'CREATE FUNCTION public.f() RETURNS void AS $$',
      'BEGIN',
      '  UPDATE public.plans SET title = 1;',
      'END $$ LANGUAGE plpgsql;',
      '',
      "UPDATE public.categories SET color = 'blue';",
    ].join('\n');
    const findings = updateFindings(sql);
    expect(findings).toHaveLength(1);
    // 関数本体（L3）ではなく top-level（L6）が報告されること
    expect(findings[0]).toMatchObject({ line: 6 });
  });

  describe('ブロックコメント経由の回避（push 前反証 risk-reviewer 指摘）', () => {
    // 旧実装は「文の先頭部分に CREATE FUNCTION が**含まれるか**」で routine 本体を判定して
    // いたため、直前のブロックコメントに同じ語があるだけで DO ブロックを本体と誤認し、
    // backfill が素通りした（実測で再現）。判定を「文の**先頭**が DO か」へ反転して閉じた。
    it('ブロックコメント内の CREATE FUNCTION に騙されず DO backfill を検知する', () => {
      const sql = [
        '/* CREATE FUNCTION note: replaced the old helper with an inline DO block */',
        'DO $$',
        'BEGIN',
        "  UPDATE public.categories SET color = 'blue';",
        'END $$;',
      ].join('\n');
      expect(updateFindings(sql)).toHaveLength(1);
    });

    it('複数行ブロックコメントでも同様に検知する', () => {
      const sql = [
        '/*',
        ' CREATE OR REPLACE FUNCTION public.old_helper()',
        ' was removed in favour of the block below',
        '*/',
        'DO $$ BEGIN UPDATE public.plans SET title = 1; END $$;',
      ].join('\n');
      expect(updateFindings(sql)).toHaveLength(1);
    });

    it('ブロックコメント内に DO があっても関数本体は依然として通す', () => {
      const sql =
        '/* DO not forget to drop the legacy helper */\n' +
        'CREATE FUNCTION public.f() RETURNS void AS $$ BEGIN UPDATE public.plans SET title = 1; END $$ LANGUAGE plpgsql;';
      expect(updateFindings(sql)).toHaveLength(0);
    });

    it('ブロックコメントで囲った UPDATE は検知しない', () => {
      expect(updateFindings('/* UPDATE public.plans SET title = 1; */')).toHaveLength(0);
    });
  });

  describe('別構文で書かれた backfill（クロスレビュー P3）', () => {
    // 第8段の色再割当ては upsert 形で書かれうる。UPDATE だけ塞いでも素通りするので
    // 同じ「既存行の書き換え」の class として一緒に閉じる。
    it.each([
      [
        'upsert backfill',
        "INSERT INTO public.categories (id, color) VALUES ('x', 'y') ON CONFLICT (id) DO UPDATE SET color = excluded.color;",
        'UPSERT_BACKFILL',
      ],
      [
        'MERGE backfill (UPDATE)',
        'MERGE INTO public.categories t USING src s ON t.id = s.id WHEN MATCHED THEN UPDATE SET color = s.color;',
        'MERGE_BACKFILL',
      ],
      [
        'MERGE backfill (DELETE)',
        'MERGE INTO public.plans t USING src s ON t.id = s.id WHEN MATCHED THEN DELETE;',
        'MERGE_BACKFILL',
      ],
    ])('%s を検知する', (_name, sql, kind) => {
      const findings = backfillFindings(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind });
    });

    it.each([
      [
        'ON CONFLICT DO NOTHING',
        "INSERT INTO public.t (id) VALUES ('x') ON CONFLICT (id) DO NOTHING;",
      ],
      [
        '関数本体の upsert（RPC のロジック）',
        'CREATE FUNCTION public.f() RETURNS void AS $$ BEGIN INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET c = 1; END $$;',
      ],
    ])('%s は検知しない', (_name, sql) => {
      expect(backfillFindings(sql)).toHaveLength(0);
    });
  });

  describe('マスク処理の穴（クロスレビュー P3・前 round の regression）', () => {
    // 前 round の実装はブロックコメント除去と dollar-quote 判定を別パスでやっており、
    // dollar-quote の**中**にある `/*` を本物のコメント開始として扱っていた。閉じ記号が
    // 無いとファイル末尾まで潰れ、後続の backfill が丸ごと消える。
    it('DO ブロック内の閉じない /* が後続の backfill を消さない', () => {
      const sql = [
        'DO $$',
        'BEGIN',
        "  PERFORM log_note('/*');",
        '  UPDATE public.categories SET color = 1;',
        'END $$;',
      ].join('\n');
      expect(updateFindings(sql)).toHaveLength(1);
    });

    it('文字列リテラル中の UPDATE ... SET は検知しない', () => {
      expect(
        updateFindings(
          "INSERT INTO public.audit (note) VALUES ('UPDATE public.plans SET title = 1');",
        ),
      ).toHaveLength(0);
    });

    it('報告する行番号がファイルの行数を超えない', () => {
      // 行コメント除去は行を**短くする**ため、マスク済みテキストと offset 表を共有すると
      // マッチ位置がずれて存在しない行を報告する（実測で確認）。
      const sql = [
        '-- 長い行コメント: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'UPDATE public.profiles',
        '  SET full_name = username',
        '  WHERE username IS NOT NULL;',
      ].join('\n');
      const findings = updateFindings(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.line).toBeLessThanOrEqual(sql.split('\n').length);
      expect(findings[0]).toMatchObject({ line: 2 });
    });
  });

  it('既存パターンの検知を巻き込まない（UPDATE と DROP COLUMN の共存）', () => {
    const findings = detectDestructivePatterns(
      ["UPDATE public.plans SET title = '';", 'ALTER TABLE public.plans DROP COLUMN legacy;'].join(
        '\n',
      ),
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(['DROP_COLUMN', 'UPDATE_BACKFILL']);
  });
});

describe('formatSummary / formatGithubOutput', () => {
  it('検知結果ゼロなら安全側のサマリーとdestructive=falseを返す', () => {
    expect(formatSummary([])).toContain('検知しませんでした');
    expect(formatGithubOutput([])).toBe('destructive=false\n');
  });

  it('検知結果ありならファイル・行・パターンを含むサマリーとdestructive=trueを返す', () => {
    const results = [
      {
        path: 'supabase/migrations/20260101000000_drop.sql',
        findings: [
          { kind: 'DROP_TABLE', label: 'DROP TABLE', line: 3, snippet: 'DROP TABLE public.x;' },
        ],
      },
    ];
    const summary = formatSummary(results);
    expect(summary).toContain('supabase/migrations/20260101000000_drop.sql');
    expect(summary).toContain('L3');
    expect(summary).toContain('EXPLICIT AUTHORITY');
    expect(formatGithubOutput(results)).toBe('destructive=true\n');
  });
});

describe('detectContractNarrowing / evaluateCoupledMigration（coupled migration、#2672 の窓）', () => {
  const mfaLockdown = `
BEGIN;
REVOKE ALL ON TABLE public.mfa_recovery_codes FROM anon, authenticated;
DROP POLICY IF EXISTS "Users can insert own recovery codes" ON public.mfa_recovery_codes;
CREATE OR REPLACE FUNCTION public.replace_mfa_recovery_codes_v1(p_user_id UUID, p_hashes TEXT[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.mfa_recovery_codes WHERE user_id = p_user_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.replace_mfa_recovery_codes_v1(UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_mfa_recovery_codes_v1(UUID, TEXT[]) TO service_role;
COMMIT;
`;

  const trialExpand = `
BEGIN;
ALTER TABLE public.profiles
  ADD COLUMN app_trial_started_at timestamptz,
  ADD COLUMN app_trial_ends_at timestamptz,
  ADD COLUMN app_trial_consumed_at timestamptz;
-- Server-owned just like subscription_status; never extend client column grants.
REVOKE INSERT (app_trial_started_at, app_trial_ends_at, app_trial_consumed_at),
       UPDATE (app_trial_started_at, app_trial_ends_at, app_trial_consumed_at)
  ON public.profiles FROM PUBLIC, anon, authenticated;
CREATE FUNCTION private.consume_app_trial_on_subscription_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.consume_app_trial_on_subscription_v1() FROM PUBLIC, anon, authenticated;
COMMIT;
`;

  const newTableTemplate = `
CREATE TABLE IF NOT EXISTS public.segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.segments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.segments TO authenticated;
`;

  it('#2672 形: 既存テーブルへの REVOKE ALL と DROP POLICY を縮小として検出し、同 PR で作った関数への REVOKE は除外する', () => {
    const findings = detectContractNarrowing([
      {
        path: 'supabase/migrations/20260908060000_lock_down_mfa_recovery_codes.sql',
        content: mfaLockdown,
      },
    ]);
    expect(findings.map((f) => [f.kind, f.target])).toEqual([
      ['REVOKE', 'public.mfa_recovery_codes'],
      ['DROP_POLICY', 'public.mfa_recovery_codes'],
    ]);
    expect(findings[0].line).toBe(3);
  });

  it('#2663 形: 同 PR で ADD COLUMN した列への列レベル REVOKE と、同 PR で CREATE した関数への REVOKE は縮小ではない', () => {
    expect(
      detectContractNarrowing([
        { path: 'supabase/migrations/20260907233848_single_plan_trial.sql', content: trialExpand },
      ]),
    ).toEqual([]);
  });

  it('新規テーブル雛形（CREATE TABLE → REVOKE ALL → GRANT）は縮小ではない', () => {
    expect(
      detectContractNarrowing([
        {
          path: 'supabase/migrations/20260818130000_create_segments.sql',
          content: newTableTemplate,
        },
      ]),
    ).toEqual([]);
  });

  it.each([
    [
      'VIEW',
      'CREATE VIEW private.plans_v2 AS SELECT 1;',
      'REVOKE ALL ON TABLE private.plans_v2 FROM PUBLIC, anon, authenticated;',
    ],
    [
      'MATERIALIZED VIEW',
      'CREATE MATERIALIZED VIEW private.stats_mv AS SELECT 1;',
      'REVOKE ALL ON private.stats_mv FROM PUBLIC;',
    ],
    [
      'UNLOGGED TABLE',
      'CREATE UNLOGGED TABLE private.revision_fence (id int);',
      'REVOKE ALL ON TABLE private.revision_fence FROM PUBLIC, anon, authenticated;',
    ],
    [
      'SCHEMA',
      'CREATE SCHEMA IF NOT EXISTS private;',
      'REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;',
    ],
  ])(
    '同 PR で作った %s への REVOKE は縮小ではない（repo の定型 CREATE → REVOKE → GRANT）',
    (_label, create, revoke) => {
      expect(
        detectContractNarrowing([
          { path: 'supabase/migrations/x.sql', content: `${create}\n${revoke}` },
        ]),
      ).toEqual([]);
    },
  );

  it('既存 schema への REVOKE は縮小として残る', () => {
    const findings = detectContractNarrowing([
      { path: 'supabase/migrations/x.sql', content: 'REVOKE USAGE ON SCHEMA public FROM anon;' },
    ]);
    expect(findings.map((f) => [f.kind, f.target])).toEqual([['REVOKE', 'schema public']]);
  });

  it('CREATE と REVOKE が別ファイルに分かれていても、同一 PR 内なら除外する', () => {
    expect(
      detectContractNarrowing([
        {
          path: 'supabase/migrations/20260101000000_a.sql',
          content: 'CREATE TABLE public.widgets (id uuid primary key);',
        },
        {
          path: 'supabase/migrations/20260101000001_b.sql',
          content: 'REVOKE ALL ON public.widgets FROM anon, authenticated;',
        },
      ]),
    ).toEqual([]);
  });

  it.each([
    ['ALTER TABLE public.plans DROP COLUMN tag_id;', 'DROP_COLUMN', 'public.plans.tag_id'],
    ['ALTER TABLE public.plans RENAME COLUMN tag_id TO activity_id;', 'RENAME', 'public.plans'],
    [
      'ALTER TABLE public.plans ALTER COLUMN title TYPE varchar(50);',
      'ALTER_COLUMN_TYPE',
      'public.plans',
    ],
    ['DROP TABLE public.tags;', 'DROP_TABLE', 'public.tags'],
    ['DROP FUNCTION public.get_tag_stats(uuid);', 'DROP_FUNCTION', 'public.get_tag_stats'],
  ])('既存オブジェクトへの %s を縮小として検出する', (sql, kind, target) => {
    const findings = detectContractNarrowing([{ path: 'supabase/migrations/x.sql', content: sql }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind, target });
  });

  it('REVOKE ... ON a, b, c は対象ごとに 1 件にし、関数の引数リストのカンマで割らない（#2666 形）', () => {
    const sql = `
REVOKE ALL PRIVILEGES ON
  public.activities,
  public.categories,
  public.segments
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.restore_single_plan_direct_write_grants_v1(UUID, TEXT[])
FROM PUBLIC, anon, authenticated, service_role;
`;
    const findings = detectContractNarrowing([{ path: 'supabase/migrations/x.sql', content: sql }]);
    expect(findings.map((f) => f.target)).toEqual([
      'public.activities',
      'public.categories',
      'public.segments',
      'private.restore_single_plan_direct_write_grants_v1',
    ]);
  });

  it('DO ブロック内の format() による動的 REVOKE は縮小として残し、対象名を <dynamic> にする', () => {
    const sql = `
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities', 'categories'] LOOP
    EXECUTE format(
      'REVOKE INSERT (%I), UPDATE (%I) ON public.%I FROM PUBLIC, anon, authenticated',
      'name', 'name', t
    );
  END LOOP;
END $$;
`;
    const findings = detectContractNarrowing([{ path: 'supabase/migrations/x.sql', content: sql }]);
    expect(findings.map((f) => [f.kind, f.target])).toEqual([['REVOKE', 'public.<dynamic>']]);
  });

  it('関数本体の中の REVOKE / DROP は文として数えない（DO ブロックは数える）', () => {
    const sql = `
CREATE OR REPLACE FUNCTION public.cleanup_v1() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'REVOKE ALL ON public.plans FROM authenticated';
END;
$$;
DO $$ BEGIN
  REVOKE SELECT ON public.records FROM anon;
END $$;
`;
    const findings = detectContractNarrowing([{ path: 'supabase/migrations/x.sql', content: sql }]);
    expect(findings.map((f) => f.target)).toEqual(['public.records']);
  });

  it('DELETE FROM / TRUNCATE / DROP TRIGGER / backfill は destructive だが縮小ではない', () => {
    const sql = `
DELETE FROM public.tags WHERE archived_at IS NOT NULL;
TRUNCATE public.stripe_webhook_events;
DROP TRIGGER legacy ON public.tags;
UPDATE public.plans SET color = 'x';
`;
    expect(detectDestructivePatterns(sql).length).toBeGreaterThan(0);
    expect(detectContractNarrowing([{ path: 'supabase/migrations/x.sql', content: sql }])).toEqual(
      [],
    );
  });

  it('縮小 + product runtime 変更が同一 PR なら coupled', () => {
    const evaluation = evaluateCoupledMigration({
      addedMigrations: [{ path: 'supabase/migrations/x.sql', content: mfaLockdown }],
      prFiles: [
        'supabase/migrations/x.sql',
        'apps/product/src/features/settings/server/recovery-code-actions.ts',
        'apps/product/src/features/settings/server/recovery-code-actions.test.ts',
      ],
    });
    expect(evaluation.coupled).toBe(true);
    expect(evaluation.appFiles).toEqual([
      'apps/product/src/features/settings/server/recovery-code-actions.ts',
    ]);
  });

  it('縮小があっても、変更が migration / 生成型 / test / story / docs / web だけなら coupled ではない', () => {
    const evaluation = evaluateCoupledMigration({
      addedMigrations: [{ path: 'supabase/migrations/x.sql', content: mfaLockdown }],
      prFiles: [
        'supabase/migrations/x.sql',
        'apps/product/src/lib/database/generated/database.types.ts',
        'apps/product/src/features/settings/server/recovery-code-actions.test.ts',
        'apps/product/src/features/settings/components/Foo.stories.tsx',
        'apps/product/src/lib/test/integration/mfa.integration.test.ts',
        'apps/product/README.md',
        'apps/web/src/app/page.tsx',
        'docs/engineering/infra.md',
      ],
    });
    expect(evaluation.coupled).toBe(false);
    expect(evaluation.narrowing).toHaveLength(2);
    expect(evaluation.appFiles).toEqual([]);
  });

  it('runtime 変更があっても縮小が無ければ coupled ではない（expand-only は同一 PR でよい）', () => {
    const evaluation = evaluateCoupledMigration({
      addedMigrations: [{ path: 'supabase/migrations/x.sql', content: trialExpand }],
      prFiles: ['supabase/migrations/x.sql', 'apps/product/src/features/billing/server/trial.ts'],
    });
    expect(evaluation.coupled).toBe(false);
  });

  it('packages/** の runtime 変更も product build の入力として数える', () => {
    expect(isProductRuntimePath('packages/billing/src/index.ts')).toBe(true);
    expect(isProductRuntimePath('packages/billing/src/index.test.ts')).toBe(false);
    expect(isProductRuntimePath('apps/web/src/lib/x.ts')).toBe(false);
  });

  it('formatCoupledSummary は縮小文・runtime ファイル・直し方（PR 分割）を含む', () => {
    const evaluation = evaluateCoupledMigration({
      addedMigrations: [{ path: 'supabase/migrations/x.sql', content: mfaLockdown }],
      prFiles: ['apps/product/src/a.ts'],
    });
    const summary = formatCoupledSummary(evaluation);
    expect(summary).toContain('merge できません');
    expect(summary).toContain('public.mfa_recovery_codes');
    expect(summary).toContain('apps/product/src/a.ts');
    expect(summary).toContain('migration だけの PR');
  });
});
