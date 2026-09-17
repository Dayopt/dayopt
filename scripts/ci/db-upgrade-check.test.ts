import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CATALOG_SQL,
  COUNT_SQL,
  PK_SQL,
  SEED_PATH,
  TYPES_PATH,
  compareCounts,
  compareRowIdentity,
  compareSchemaContracts,
  extractSchemaContract,
  parseCounts,
  parsePrimaryKeys,
  planDbUpgrade,
  rowIdentitySql,
  runDbUpgradeCheck,
} from './db-upgrade-check.mjs';

const REAL_TYPES = readFileSync(join(process.cwd(), TYPES_PATH), 'utf8');

const typesFixture = (extra = '') => `export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      activities: {
        Row: {
          archived_at: string | null;
          id: string;
          name: string;
        };
        Insert: {
          archived_at?: string | null;
          id?: string;
          name: string;
        };
        Relationships: [
          {
            foreignKeyName: 'activities_category_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
        ];
      };
      categories: {
        Row: {
          color: string;
          id: string;
        };
        Insert: {
          color: string;
        };
        Relationships: [];
      };${extra}
    };
    Views: {
      activity_stats_v1: {
        Row: {
          total: number | null;
        };
      };
    };
    Functions: {
      abandon_billing_customer_provisioning_v1: {
        Args: { p_operation_id: string; p_user_id: string };
        Returns: boolean;
      };
      get_plan_v2: {
        Args: { p_id: string };
        Returns: string;
      };
    };
    Enums: {
      record_kind: 'plan' | 'record';
      mcp_scope:
        | 'read'
        | 'write';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
`;

describe('schema contract extraction', () => {
  it('reads tables, columns, views, functions and enum values from the public schema only', () => {
    const contract = extractSchemaContract(typesFixture());
    expect([...contract.tables.keys()]).toEqual(['activities', 'categories']);
    expect([...contract.tables.get('activities')!.columns]).toEqual([
      ['archived_at', 'string | null'],
      ['id', 'string'],
      ['name', 'string'],
    ]);
    expect(contract.tables.get('activities')!.insert.get('name')).toEqual({
      type: 'string',
      optional: false,
    });
    expect(contract.tables.get('activities')!.insert.get('id')).toEqual({
      type: 'string',
      optional: true,
    });
    expect([...contract.tables.get('activities')!.relationships]).toEqual([
      "foreignKeyName='activities_category_fkey' columns=['category_id'] isOneToOne=false referencedRelation='categories' referencedColumns=['id']",
    ]);
    // field 順の入れ替えと契約外 field の追加（CLI 更新）は同じ契約
    const reordered = extractSchemaContract(
      typesFixture().replace(
        "            foreignKeyName: 'activities_category_fkey';\n            columns: ['category_id'];",
        "            columns: ['category_id'];\n            foreignKeyName: 'activities_category_fkey';\n            deferrable: false;",
      ),
    );
    expect(compareSchemaContracts(contract, reordered).narrowing).toBe(false);
    expect(contract.tables.get('categories')!.relationships.size).toBe(0);
    expect([...contract.views.keys()]).toEqual(['activity_stats_v1']);
    expect([...contract.views.get('activity_stats_v1')!.columns]).toEqual([
      ['total', 'number | null'],
    ]);
    expect([...contract.functions.keys()]).toEqual([
      'abandon_billing_customer_provisioning_v1',
      'get_plan_v2',
    ]);
    expect(contract.functions.get('get_plan_v2')).toEqual({
      raw: 'Args: { p_id: string }; Returns: string;',
      args: new Map([['p_id', { type: 'string', optional: false }]]),
      returns: 'string',
    });
    expect([...contract.enums.get('record_kind')!]).toEqual(['plan', 'record']);
    expect([...contract.enums.get('mcp_scope')!]).toEqual(['read', 'write']);
  });

  it('parses the real generated file without confusing Insert/Update keys with Row columns', () => {
    const contract = extractSchemaContract(REAL_TYPES);
    expect(contract.tables.size).toBeGreaterThan(10);
    expect(contract.functions.size).toBeGreaterThan(10);
    expect([...contract.tables.get('activities')!.columns.keys()]).toEqual([
      'archived_at',
      'category_id',
      'created_at',
      'id',
      'name',
      'updated_at',
      'user_id',
    ]);
    expect(contract.tables.get('activities')!.columns.get('user_id')).toBe('string');
    expect(contract.tables.get('activities')!.update.get('name')?.optional).toBe(true);
    // 1 行形式の function（`vault_secret_exists: { Args: {...}; Returns: boolean };`）と
    // 複数行の Args / object Returns も構造化される。section の末尾を飲み込まない
    const fns = [...contract.functions.values()];
    expect(fns.every((fn) => fn.args !== null)).toBe(true);
    expect(contract.functions.get('vault_secret_exists')).toMatchObject({ returns: 'boolean' });
    expect(compareSchemaContracts(contract, contract).narrowing).toBe(false);
  });

  it('treats view column and RPC signature changes as narrowing (old consumer)', () => {
    const base = extractSchemaContract(typesFixture());
    const viewNarrowed = extractSchemaContract(
      typesFixture().replace('          total: number | null;\n', ''),
    );
    expect(compareSchemaContracts(base, viewNarrowed).removed.viewColumns).toEqual([
      'activity_stats_v1.total',
    ]);
    const argRenamed = extractSchemaContract(
      typesFixture().replace('Args: { p_id: string };', 'Args: { p_plan_id: string };'),
    );
    expect(compareSchemaContracts(base, argRenamed).removed.functionSignatures).toEqual([
      'get_plan_v2(p_id): argument removed',
      'get_plan_v2(p_plan_id): new required argument (old callers omit it)',
    ]);
    const argOptionalAdded = extractSchemaContract(
      typesFixture().replace('Args: { p_id: string };', 'Args: { p_id: string; p_tz?: string };'),
    );
    expect(compareSchemaContracts(base, argOptionalAdded).narrowing).toBe(false);
    const returnsChanged = extractSchemaContract(
      typesFixture().replace(
        '        Returns: string;\n      };\n    };',
        '        Returns: string | null;\n      };\n    };',
      ),
    );
    expect(compareSchemaContracts(base, returnsChanged).removed.functionSignatures).toEqual([
      'get_plan_v2: returns string → string | null',
    ]);
  });

  it('reports removed objects as narrowing and ignores additions', () => {
    const base = extractSchemaContract(typesFixture());
    const wider = extractSchemaContract(
      typesFixture(`
      plans: {
        Row: {
          id: string;
        };
        Relationships: [];
      };`),
    );
    expect(compareSchemaContracts(base, wider).narrowing).toBe(false);
    const narrower = extractSchemaContract(
      typesFixture().replace(
        '          name: string;\n        };\n        Insert',
        '        };\n        Insert',
      ),
    );
    const result = compareSchemaContracts(base, narrower);
    expect(result.narrowing).toBe(true);
    expect(result.removed.columns).toEqual(['activities.name']);
    const noEnum = extractSchemaContract(
      typesFixture().replace("record_kind: 'plan' | 'record';", "record_kind: 'plan';"),
    );
    expect(compareSchemaContracts(base, noEnum).removed.enumValues).toEqual(['record_kind.record']);
  });

  it('treats type, nullability and write-contract changes as narrowing (old consumer)', () => {
    const base = extractSchemaContract(typesFixture());
    const retyped = extractSchemaContract(
      typesFixture().replace(
        '          name: string;\n        };\n        Insert',
        '          name: number;\n        };\n        Insert',
      ),
    );
    expect(compareSchemaContracts(base, retyped).removed.columnTypes).toEqual([
      'activities.name: string → number',
    ]);
    const nullable = extractSchemaContract(
      typesFixture().replace(
        '          id: string;\n          name: string;',
        '          id: string;\n          name: string | null;',
      ),
    );
    expect(compareSchemaContracts(base, nullable).removed.columnTypes).toEqual([
      'activities.name: string → string | null',
    ]);
    const requiredInsert = extractSchemaContract(
      typesFixture().replace(
        '          id?: string;\n          name: string;',
        '          id: string;\n          name: string;',
      ),
    );
    expect(compareSchemaContracts(base, requiredInsert).removed.writeContracts).toEqual([
      'activities.id (insert): optional → required',
    ]);
    const newRequired = extractSchemaContract(
      typesFixture().replace(
        '          color: string;\n        };\n        Relationships',
        '          color: string;\n          owner_id: string;\n        };\n        Relationships',
      ),
    );
    expect(compareSchemaContracts(base, newRequired).removed.writeContracts).toEqual([
      'categories.owner_id (insert): new required column (old writers omit it)',
    ]);
    const optionalAdded = extractSchemaContract(
      typesFixture().replace(
        '          color: string;\n        };\n        Relationships',
        '          color: string;\n          owner_id?: string | null;\n        };\n        Relationships',
      ),
    );
    expect(compareSchemaContracts(base, optionalAdded).narrowing).toBe(false);
    // Row には残るが Insert / Update から消えた列（generated 化）は旧 writer を壊す
    const readOnly = extractSchemaContract(
      typesFixture().replace(
        '          archived_at?: string | null;\n          id?: string;\n          name: string;\n        };\n        Relationships: [\n',
        '          id?: string;\n          name: string;\n        };\n        Relationships: [\n',
      ),
    );
    expect(compareSchemaContracts(base, readOnly).removed.writeContracts).toEqual([
      'activities.archived_at (insert): no longer writable',
    ]);
    expect(compareSchemaContracts(base, readOnly).removed.columns).toEqual([]);
    // relationship の削除 / 付け替えも narrowing
    const relDropped = extractSchemaContract(
      typesFixture().replace(
        "referencedRelation: 'categories';",
        "referencedRelation: 'category_owners';",
      ),
    );
    expect(compareSchemaContracts(base, relDropped).removed.relationships).toEqual([
      "activities: foreignKeyName='activities_category_fkey' columns=['category_id'] isOneToOne=false referencedRelation='categories' referencedColumns=['id']",
    ]);
  });
});

describe('upgrade plan', () => {
  const base = ['00000000000000_baseline.sql', '20260901000000_a.sql'];
  it('skips when the PR adds no migration', () => {
    expect(planDbUpgrade({ base, candidate: base, changed: [] })).toMatchObject({
      status: 'skip',
      baseVersion: '20260901000000',
      added: [],
    });
  });
  it('runs from the newest base version with only the added migrations', () => {
    const plan = planDbUpgrade({
      base,
      candidate: [...base, '20260917000000_b.sql', '20260816000000_backfill.sql'],
      changed: [
        { status: 'A', path: 'supabase/migrations/20260917000000_b.sql' },
        { status: 'A', path: 'supabase/migrations/20260816000000_backfill.sql' },
      ],
    });
    expect(plan.status).toBe('run');
    expect(plan.baseVersion).toBe('20260901000000');
    expect(plan.added).toEqual(['20260917000000_b.sql', '20260816000000_backfill.sql']);
  });
  it('fails when an applied migration is edited or removed, but ignores the archive', () => {
    const edited = planDbUpgrade({
      base,
      candidate: base,
      changed: [{ status: 'M', path: 'supabase/migrations/20260901000000_a.sql' }],
    });
    expect(edited.status).toBe('fail');
    expect(edited.problems[0]).toMatch(/applied migration edited/);
    const removed = planDbUpgrade({
      base,
      candidate: ['00000000000000_baseline.sql'],
      changed: [{ status: 'D', path: 'supabase/migrations/20260901000000_a.sql' }],
    });
    expect(removed.problems[0]).toMatch(/applied migration removed/);
    const archived = planDbUpgrade({
      base,
      candidate: base,
      changed: [{ status: 'M', path: 'supabase/migrations/_archive/20250101000000_old.sql' }],
    });
    expect(archived.status).toBe('skip');
  });
  it('fails without a trusted baseline', () => {
    expect(
      planDbUpgrade({ base: [], candidate: ['20260917000000_b.sql'], changed: [] }).status,
    ).toBe('fail');
  });
});

describe('row identity comparison', () => {
  it('builds one identity query from the primary keys and detects same-count replacement', () => {
    const keys = parsePrimaryKeys(
      'public.activities,id\npublic.plan_activities,plan_id|activity_id\n',
    );
    const sql = rowIdentitySql(keys);
    expect(sql).toContain(
      `select 'public.activities' || ',' || row("id")::text from "public"."activities"`,
    );
    expect(sql).toContain('row("plan_id", "activity_id")::text from "public"."plan_activities"');
    expect(sql).toMatch(/ union all .* order by 1$/);
    expect(rowIdentitySql(new Map())).toBe('select null where false');
    const before =
      'public.activities,(a1)\npublic.activities,(a2)\npublic.plan_activities,(p1,a1)\n';
    // 同数の入れ替え（a2 → a3）と新規行の追加（a4）: 追加は互換、入れ替えは消失
    const after =
      'public.activities,(a1)\npublic.activities,(a3)\npublic.activities,(a4)\npublic.plan_activities,(p1,a1)\n';
    expect(compareRowIdentity(before, after)).toEqual([
      'public.activities: 1 seeded row(s) no longer present by primary key (e.g. (a2))',
    ]);
    expect(compareRowIdentity(before, before)).toEqual([]);
  });
});

describe('row count comparison', () => {
  it('flags lost rows and missing tables, not growth or new tables', () => {
    const before = parseCounts('public.activities,5\npublic.categories,2\nauth.users,1\n');
    const after = parseCounts('public.activities,5\npublic.categories,1\npublic.plans,9\n');
    expect(compareCounts(before, after)).toEqual([
      'public.categories: 2 → 1 rows',
      'auth.users: table missing after upgrade',
    ]);
    expect(COUNT_SQL).toContain("table_schema in ('public', 'auth', 'private')");
    expect(PK_SQL).toContain("tc.table_schema in ('public', 'auth', 'private')");
    expect(CATALOG_SQL).toContain(
      "n.nspname in ('public', 'auth', 'private') and not t.tgisinternal",
    );
  });
});

describe('runDbUpgradeCheck orchestration', () => {
  type Call = [string, string[]];
  function harness({
    candidateMigrations = [
      '00000000000000_baseline.sql',
      '20260901000000_a.sql',
      '20260917000000_b.sql',
    ],
    countsAfter = 'public.activities,3\nauth.users,1\n',
    upgradedTypes = typesFixture(),
    freshTypes = typesFixture(),
    baseTypes = typesFixture(),
    changed = 'A\tsupabase/migrations/20260917000000_b.sql\n',
    migrationUpFails = false,
    resetFails = false,
    rowsAfter = 'public.activities,(a1)\npublic.activities,(a2)\npublic.activities,(a3)\n',
    freshCatalog = 'index:public.activities_pkey CREATE UNIQUE INDEX ...\n',
  } = {}) {
    const calls: Call[] = [];
    const moves: [string, string][] = [];
    const resets: string[][] = [];
    const seedAtReset: string[] = [];
    const inMigrationsDir = new Set(candidateMigrations);
    const files = new Map<string, string>([[SEED_PATH, 'candidate seed']]);
    const exec = (file: string, args: string[]) => {
      calls.push([file, args]);
      const joined = `${file} ${args.join(' ')}`;
      if (joined.startsWith('git rev-parse --verify HEAD^1')) return 'b'.repeat(40);
      if (joined.startsWith('git rev-parse --verify HEAD^2')) return 'a'.repeat(40);
      if (joined.startsWith('git ls-tree'))
        return 'supabase/migrations/00000000000000_baseline.sql\nsupabase/migrations/20260901000000_a.sql\n';
      if (joined.startsWith('git diff --name-status')) return changed;
      if (joined.startsWith('git show') && args[1].endsWith(SEED_PATH)) return 'base seed';
      if (joined.startsWith('git show')) return baseTypes;
      if (joined.startsWith('supabase db reset')) {
        // reset は `supabase/migrations` に **今ある** ファイルを全部当てる
        resets.push([...inMigrationsDir].sort());
        seedAtReset.push(files.get(SEED_PATH)!);
        if (resetFails) throw new Error('supabase db reset failed (exit 1): seed error');
        return '';
      }
      if (joined.startsWith('supabase migration up')) {
        if (migrationUpFails)
          throw new Error('supabase migration up failed (exit 1): ERROR: column exists');
        return '';
      }
      if (joined.startsWith('psql') && args.includes(PK_SQL)) return 'public.activities,id\n';
      if (joined.startsWith('psql') && args.some((a) => a.includes('row("id")::text')))
        return calls.filter(([f, a]) => f === 'psql' && a.some((x) => x.includes('row(')))
          .length === 1
          ? 'public.activities,(a1)\npublic.activities,(a2)\npublic.activities,(a3)\n'
          : rowsAfter;
      if (joined.startsWith('psql') && args.includes(CATALOG_SQL))
        return resets.length >= 2
          ? freshCatalog
          : 'index:public.activities_pkey CREATE UNIQUE INDEX ...\n';
      if (joined.startsWith('psql'))
        return calls.filter(([f, a]) => f === 'psql' && a.includes(COUNT_SQL)).length === 1
          ? 'public.activities,3\nauth.users,1\n'
          : countsAfter;
      if (joined.startsWith('pnpm rls:snapshot:check')) return '';
      if (joined.startsWith('supabase gen types')) return upgradedTypes;
      if (joined.startsWith('pnpm exec prettier')) return upgradedTypes;
      throw new Error(`unexpected exec: ${joined}`);
    };
    const result = runDbUpgradeCheck({
      exec,
      readFile: (path) => (path === SEED_PATH ? files.get(SEED_PATH)! : freshTypes),
      writeFile: (path, text) => files.set(path, text),
      listMigrations: () => candidateMigrations,
      moveFile: (from, to) => {
        moves.push([from, to]);
        const name = from.split('/').at(-1)!;
        if (from.includes('/supabase/migrations/')) inMigrationsDir.delete(name);
        else inMigrationsDir.add(name);
      },
      makeTempDir: () => '/tmp/stash',
      log: () => {},
      summaryPath: null,
      resultPath: null,
    });
    return { result, calls, moves, resets, inMigrationsDir, seedAtReset, files };
  }

  it('resets to the base set with seed (added migrations stashed), applies only added migrations and passes', () => {
    const { result, calls, resets, inMigrationsDir, seedAtReset, files } = harness();
    expect(result.status).toBe('pass');
    expect(calls).toContainEqual(['supabase', ['db', 'reset', '--local']]);
    // 1 回目の reset は base の集合だけ、2 回目（fresh 比較）は candidate 全部
    expect(resets[0]).toEqual(['00000000000000_baseline.sql', '20260901000000_a.sql']);
    expect(resets[1]).toEqual([
      '00000000000000_baseline.sql',
      '20260901000000_a.sql',
      '20260917000000_b.sql',
    ]);
    expect(inMigrationsDir.has('20260917000000_b.sql')).toBe(true);
    // 1 回目の reset は base の seed、fresh 比較の reset は candidate の seed。終了後は candidate に戻る
    expect(seedAtReset).toEqual(['base seed', 'candidate seed']);
    expect(files.get(SEED_PATH)).toBe('candidate seed');
    expect(calls).toContainEqual(['supabase', ['migration', 'up', '--local', '--include-all']]);
    expect(Object.keys(result.checks)).toEqual([
      'upgrade',
      'dataPreserved',
      'rlsSnapshot',
      'freshEquivalence',
      'oldConsumer',
      'catalogEquivalence',
    ]);
  });

  it('stashes an added migration with an older timestamp so the base reset cannot apply it before seed', () => {
    const { resets, inMigrationsDir } = harness({
      candidateMigrations: [
        '00000000000000_baseline.sql',
        '20260816000000_backfill.sql',
        '20260901000000_a.sql',
      ],
      changed: 'A\tsupabase/migrations/20260816000000_backfill.sql\n',
    });
    expect(resets[0]).toEqual(['00000000000000_baseline.sql', '20260901000000_a.sql']);
    expect(inMigrationsDir.has('20260816000000_backfill.sql')).toBe(true);
  });

  it('restores stashed migrations and the candidate seed even when the reset fails', () => {
    const { result, inMigrationsDir, files } = harness({ resetFails: true });
    expect(result.status).toBe('fail');
    expect(result.problems[0]).toMatch(/db reset failed/);
    expect(inMigrationsDir.has('20260917000000_b.sql')).toBe(true);
    expect(files.get(SEED_PATH)).toBe('candidate seed');
  });

  it('fails when seeded rows are replaced by different rows with the same count', () => {
    const { result } = harness({
      rowsAfter: 'public.activities,(a1)\npublic.activities,(a2)\npublic.activities,(a9)\n',
    });
    expect(result.status).toBe('fail');
    expect(result.problems[0]).toMatch(
      /seeded rows lost: public.activities: 1 seeded row\(s\) no longer present by primary key \(e.g. \(a3\)\)/,
    );
  });

  it('fails when indexes / constraints / triggers differ between upgraded and fresh', () => {
    const { result } = harness({
      freshCatalog:
        'index:public.activities_pkey CREATE UNIQUE INDEX ...\nindex:public.plans_user_idx CREATE INDEX ...\n',
    });
    expect(result.status).toBe('fail');
    expect(result.problems[0]).toMatch(
      /upgraded catalog differs from the fresh catalog \(only after upgrade: none; only in fresh: index:public.plans_user_idx/,
    );
  });

  it('skips without touching the database when no migration is added', () => {
    const { result, calls } = harness({
      candidateMigrations: ['00000000000000_baseline.sql', '20260901000000_a.sql'],
      changed: '',
    });
    expect(result.status).toBe('skip');
    expect(calls.some(([file]) => file === 'supabase')).toBe(false);
  });

  it('fails when the candidate migration errors on the seeded base', () => {
    const { result } = harness({ migrationUpFails: true });
    expect(result.status).toBe('fail');
    expect(result.problems[0]).toMatch(/migration up failed/);
  });

  it('fails when seeded rows are lost, when fresh and upgraded schemas differ, and on narrowing', () => {
    expect(
      harness({ countsAfter: 'public.activities,0\nauth.users,1\n' }).result.problems[0],
    ).toMatch(/seeded rows lost: public.activities: 3 → 0/);
    expect(harness({ freshTypes: typesFixture('\n      // drift') }).result.problems[0]).toMatch(
      /upgraded schema differs from the fresh schema/,
    );
    const narrowed = harness({
      baseTypes: typesFixture(`
      legacy: {
        Row: {
          id: string;
        };
        Relationships: [];
      };`),
    });
    expect(narrowed.result.status).toBe('fail');
    expect(narrowed.result.problems[0]).toMatch(
      /old consumer contract narrowed \(tables: legacy\)/,
    );
  });

  it('fails closed when the base revision cannot be resolved', () => {
    const result = runDbUpgradeCheck({
      exec: () => {
        throw new Error('no parents');
      },
      readFile: () => '',
      listMigrations: () => [],
      log: () => {},
      summaryPath: null,
      resultPath: null,
    });
    expect(result.status).toBe('fail');
    expect(result.problems[0]).toMatch(/base revision unavailable/);
  });
});
