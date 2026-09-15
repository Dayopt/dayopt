import { describe, expect, it } from 'vitest';

import {
  mapInventoryToConcepts,
  renderConceptDiagram,
  summarizeByKind,
} from '../lib/architecture-map/concept-map.ts';
import {
  renderErDiagram,
  renderTableIndex,
  toMermaidType,
} from '../lib/architecture-map/er-diagram.ts';
import {
  buildFeatureDag,
  checkFeatureDagConsistency,
  collectFeatureDependencies,
  parseFeatureRules,
  renderFeatureDagDiagram,
} from '../lib/architecture-map/feature-dag.ts';
import {
  architectureMapMarkers,
  replaceGeneratedBlock,
} from '../lib/architecture-map/generated-block.ts';
import {
  discoverMcpTools,
  discoverTrpcProcedures,
  discoverTrpcRouters,
  featureOf,
} from '../lib/architecture-map/inventory.ts';
import {
  likec4Id,
  renderLikeC4Model,
  renderLikeC4Views,
} from '../lib/architecture-map/likec4-model.ts';
import {
  checkGlossaryReferences,
  checkTimeRuleMirrorReferences,
} from '../lib/architecture-map/references.ts';
import { parseSchemaModel } from '../lib/architecture-map/schema-model.ts';
import {
  parseTimeRulesSection,
  renderTimeRulesDiagram,
} from '../lib/architecture-map/time-rules.ts';
import type { GlossaryEntry } from '../lib/glossary/core.ts';
import {
  checkArchitectureReferences,
  findStaleArchitectureMapDocs,
} from '../tasks/generate-architecture-map.ts';

/**
 * Supabase 生成型の最小 fixture。実ファイルと同じ入れ子（Database.public.Tables.<t>.Row /
 * Relationships、Functions）だけを再現する。
 */
const SCHEMA_FIXTURE = `
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type Database = {
  public: {
    Tables: {
      plans: {
        Row: {
          id: string;
          title: string;
          note: string | null;
          activity_id: string | null;
          user_id: string;
          tags: string[];
          payload: Json;
        };
        Insert: { id?: string };
        Update: { id?: string };
        Relationships: [
          {
            foreignKeyName: 'plans_activity_owner_fkey';
            columns: ['activity_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      activities: {
        Row: { id: string; user_id: string; name: string };
        Insert: { id?: string };
        Update: { id?: string };
        Relationships: [];
      };
      profiles: {
        Row: { id: string; email: string };
        Insert: { id?: string };
        Update: { id?: string };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      create_plan_command_v1: { Args: { p: string }; Returns: Json };
      graphql: { Args: { query?: string }; Returns: Json };
    };
    Enums: { [_ in never]: never };
  };
};
`;

const INVARIANTS_FIXTURE = `
## 時刻

- 規則は 2 本だけ:
  - \`end_at > start_at\`（Plan / Record 共通、\`DT003\` / \`INVALID_TIME_RANGE\`）
  - **Record は未来に終われない**（\`end_at <= now\`、\`validate_record_temporal_write_v1\`、
    \`DT005\` / \`RECORD_IN_FUTURE\`）

### 規則の写しと、その分類

| 分類 | 場所 | 役割 | 消してよいか |
| --- | --- | --- | --- |
| (a) 契約変換 | \`features/timeblock/server/client.ts\` の \`EXPECTED_ERRORS\` | DT コード → code | 不可（UI が分岐する） |
| (b) UX 先回り | \`features/calendar/lib/overlap.ts\` + \`lib/time/time-conflict.ts\` | 重なりの事前表示 | 可（DB が正） |

後文。

## 次のセクション
`;

describe('schema-model: database.types.ts の構造を読む', () => {
  const model = parseSchemaModel(SCHEMA_FIXTURE);

  it('テーブルを名前順に取り出し、列の nullable と FK を持つ', () => {
    expect(model.tables.map((t) => t.name)).toEqual(['activities', 'plans', 'profiles']);
    const plans = model.tables.find((t) => t.name === 'plans');
    expect(plans?.columns.find((c) => c.name === 'note')).toEqual({
      name: 'note',
      type: 'string',
      nullable: true,
    });
    expect(plans?.relationships).toEqual([
      {
        name: 'plans_activity_owner_fkey',
        columns: ['activity_id', 'user_id'],
        referencedTable: 'activities',
        referencedColumns: ['id', 'user_id'],
        isOneToOne: false,
      },
    ]);
    expect(model.functions).toEqual(['create_plan_command_v1', 'graphql']);
  });

  it('Tables が無い入力は fail closed で例外にする', () => {
    expect(() => parseSchemaModel('export type Database = { public: {} };')).toThrow(
      /public\.Tables/,
    );
  });
});

describe('er-diagram: model から Mermaid を描く', () => {
  const model = parseSchemaModel(SCHEMA_FIXTURE);

  it('型名を Mermaid の attribute type 1 語へ寄せる', () => {
    expect(toMermaidType('string')).toBe('string');
    expect(toMermaidType('Json')).toBe('json');
    expect(toMermaidType('string[]')).toBe('string_array');
    expect(toMermaidType("Database['public']['Enums']['plan_source']")).toBe('enum_plan_source');
  });

  it('全体図は FK 列に FK を付け、nullable を comment で示し、関係線を引く', () => {
    const diagram = renderErDiagram(model);
    expect(diagram).toContain('erDiagram');
    expect(diagram).toContain('    string activity_id FK "nullable"');
    expect(diagram).toContain('    string_array tags');
    expect(diagram).toContain('  plans }o--|| activities : "activity_id, user_id"');
    // 参照先（auth.users）が public に無い FK は線を引かない
    expect(diagram).not.toContain('profiles ||--|| users');
  });

  it('部分集合の図は選択外へ向かう FK を省く', () => {
    const diagram = renderErDiagram(model, ['plans']);
    expect(diagram).toContain('  plans {');
    expect(diagram).not.toContain('activities {');
    expect(diagram).not.toContain('}o--||');
  });

  it('テーブル一覧は列数と FK 参照先を持つ', () => {
    const index = renderTableIndex(model);
    expect(index).toContain('| `plans` | 7 | `activities` |');
    expect(index).toContain('| `activities` | 3 | — |');
  });
});

describe('time-rules: invariants.md §時刻 の写し表を読んで描く', () => {
  const section = parseTimeRulesSection(INVARIANTS_FIXTURE);

  it('DB 規則と写し行を取り出す', () => {
    expect(section.dbRules).toEqual([
      { code: 'DT003', expression: 'end_at > start_at' },
      { code: 'DT005', expression: 'end_at <= now' },
    ]);
    expect(section.mirrors).toHaveLength(2);
    expect(section.mirrors[0]).toMatchObject({
      kind: 'a',
      paths: ['features/timeblock/server/client.ts'],
      symbols: ['EXPECTED_ERRORS'],
      removable: false,
    });
    expect(section.mirrors[1]).toMatchObject({
      kind: 'b',
      paths: ['features/calendar/lib/overlap.ts', 'lib/time/time-conflict.ts'],
      symbols: [],
      removable: true,
    });
  });

  it('流れ図は契約変換を実線、UX 先回りを点線で結び、消してよい写しを破線枠にする', () => {
    const diagram = renderTimeRulesDiagram(section);
    expect(diagram).toContain('DT003["DT003<br/>end_at #gt; start_at"]');
    expect(diagram).toContain('contract1["client.ts<br/>EXPECTED_ERRORS<br/>消せない"]');
    expect(diagram).toContain('ux1["overlap.ts<br/>time-conflict.ts<br/>消してよい"]');
    expect(diagram).toContain('  db --> contract1');
    expect(diagram).toContain('  db -.-> ux1');
    expect(diagram).toContain('  class ux1 removable');
  });

  it('表が無ければ fail closed で例外にする', () => {
    expect(() => parseTimeRulesSection('## 時刻\n\n本文だけ\n')).toThrow(/規則の写し/);
  });
});

describe('generated-block: マーカー間だけを差し替える', () => {
  const markers = architectureMapMarkers('er', 'source.ts');

  it('前後の手書き部分を残す', () => {
    const doc = `前文\n\n${markers.start}\n\n古い\n\n${markers.end}\n\n後文\n`;
    expect(replaceGeneratedBlock(doc, markers, '新しい', 'doc')).toBe(
      `前文\n\n${markers.start}\n\n新しい\n\n${markers.end}\n\n後文\n`,
    );
  });

  it('マーカーが無ければ例外にする（黙って全文を置き換えない）', () => {
    expect(() => replaceGeneratedBlock('マーカーなし', markers, 'x', 'doc')).toThrow(
      /生成マーカー/,
    );
  });
});

describe('references: text 正本の参照切れを検出する', () => {
  const model = parseSchemaModel(SCHEMA_FIXTURE);
  const sources = [
    {
      path: 'apps/product/src/features/timeblock/server/client.ts',
      text: 'export const EXPECTED_ERRORS = {};',
    },
    {
      path: 'apps/product/src/features/timeblock/types/plan-event.ts',
      text: 'export type PlanEvent = {};',
    },
  ];

  it('glossary の db / identifiers の実在を検査する', () => {
    const entry = (overrides: Partial<GlossaryEntry>): GlossaryEntry => ({
      id: 'x',
      layer: 'code',
      status: 'current',
      concept: 'X',
      usage: 'u',
      ...overrides,
    });
    const violations = checkGlossaryReferences(
      [
        entry({
          id: 'ok',
          code: { identifiers: ['PlanEvent'] },
          db: ['plans', 'plans.note', 'create_plan_command_v1'],
        }),
        entry({
          id: 'bad',
          code: { identifiers: ['MissingSymbol', "'a' | 'b'"] },
          db: ['plans.gone', 'ghost_table'],
        }),
      ],
      model,
      sources,
      '/nonexistent-root',
    );
    expect(violations.map((v) => `${v.source}: ${v.reason}`)).toEqual([
      "glossary:bad: code.identifiers 'MissingSymbol' が apps/product/src に見つかりません",
      "glossary:bad: db 'plans.gone' の列 gone が plans にありません",
      "glossary:bad: db 'ghost_table' は public のテーブルにも関数にもありません",
    ]);
  });

  it('写し表の path と symbol の実在を検査する', () => {
    const section = parseTimeRulesSection(INVARIANTS_FIXTURE);
    const violations = checkTimeRuleMirrorReferences(section.mirrors, sources);
    expect(violations.map((v) => v.reason)).toEqual([
      'path がありません: apps/product/src/features/calendar/lib/overlap.ts',
      'path がありません: apps/product/src/lib/time/time-conflict.ts',
    ]);
  });
});

describe('repo の Architecture Map は最新で、参照は全件実在する', () => {
  it('生成ブロックが text 正本と一致する（pnpm architecture:generate で更新）', async () => {
    expect(await findStaleArchitectureMapDocs()).toEqual([]);
  });

  it('glossary / invariants の参照先が実在する', () => {
    expect(checkArchitectureReferences()).toEqual([]);
  });
});

const ESLINT_FIXTURE = `
export default [
  {
    files: ['src/features/activities/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@/features/*', '@/features/**'], message: 'L0' }] }] },
  },
  {
    files: ['src/features/timeblock/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [
          { group: ['@/features/calendar', '@/features/calendar/**'], message: 'L2' },
          { group: ['@/features/activities/**'], message: 'barrel only' },
        ] },
      ],
    },
  },
  {
    files: ['src/features/calendar/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@/features/activities/**', '@/features/timeblock/**'], message: 'barrel only' }] }] },
  },
  {
    files: ['src/features/settings/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@/features/*/**'], message: 'deep' }] }] },
  },
  {
    files: ['src/features/auth/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@/features/*', '@/features/**'], message: 'independent' }] }] },
  },
];
`;

describe('feature-dag: eslint 規則と実 import から Feature DAG を組む', () => {
  const rules = parseFeatureRules(ESLINT_FIXTURE);
  const sources = [
    {
      path: 'apps/product/src/features/timeblock/a.ts',
      text: "import { x } from '@/features/activities';",
    },
    {
      path: 'apps/product/src/features/calendar/b.tsx',
      text: "import { y } from '@/features/timeblock';\nimport { z } from '@/features/activities';",
    },
    {
      path: 'apps/product/src/features/calendar/b.stories.tsx',
      text: "import { s } from '@/features/settings';",
    },
    {
      path: 'apps/product/src/features/settings/c.ts',
      text: "const m = await import('@/features/calendar');",
    },
    { path: 'apps/product/src/features/auth/d.ts', text: "import { q } from '@/lib/x';" },
  ];

  it('規則を feature ごとに分類する', () => {
    expect(rules.get('activities')).toMatchObject({ bansAllFeatures: true, bannedFeatures: [] });
    expect(rules.get('timeblock')).toMatchObject({
      bansAllFeatures: false,
      bannedFeatures: ['calendar'],
    });
    expect(rules.get('settings')).toMatchObject({ deepImportOnlyBan: true, bannedFeatures: [] });
  });

  it('runtime import だけを edge にし、stories / test と自己 import を除く', () => {
    expect(collectFeatureDependencies(sources)).toEqual([
      { from: 'calendar', to: 'activities' },
      { from: 'calendar', to: 'timeblock' },
      { from: 'settings', to: 'calendar' },
      { from: 'timeblock', to: 'activities' },
    ]);
  });

  it('層は依存の最長経路、種別は規則から決める', () => {
    const dag = buildFeatureDag(rules, collectFeatureDependencies(sources));
    expect(Object.fromEntries(dag.layers)).toEqual({
      activities: 0,
      auth: 0,
      calendar: 2,
      settings: 3,
      timeblock: 1,
    });
    expect(dag.kinds.get('activities')).toBe('layer0');
    expect(dag.kinds.get('auth')).toBe('independent');
    expect(dag.kinds.get('settings')).toBe('composition');
    expect(dag.kinds.get('calendar')).toBe('layered');
    expect(checkFeatureDagConsistency(dag)).toEqual([]);
  });

  it('規則が禁止する edge を不整合として返す', () => {
    const dag = buildFeatureDag(rules, [
      { from: 'timeblock', to: 'calendar' },
      { from: 'activities', to: 'timeblock' },
    ]);
    expect(checkFeatureDagConsistency(dag)).toEqual([
      'timeblock → calendar は eslint で禁止されている',
      'activities は他 feature への依存が禁止だが timeblock を import している',
    ]);
  });

  it('図は層ごとの subgraph と edge を持つ', () => {
    const diagram = renderFeatureDagDiagram(
      buildFeatureDag(rules, collectFeatureDependencies(sources)),
    );
    expect(diagram).toContain('  subgraph L0["Layer 0"]');
    expect(diagram).toContain('    activities["activities (Layer 0)"]');
    expect(diagram).toContain('    settings["settings (composition)"]');
    expect(diagram).toContain('    auth["auth (independent)"]');
    expect(diagram).toContain('  calendar --> timeblock');
  });
});

describe('inventory: 実装から項目を自動発見する', () => {
  const appRouter = {
    path: 'apps/product/src/app/api/trpc/_server/app-router.ts',
    text: `
import { activitiesRouter } from '@/features/activities/server/router';
import { createUserRouter } from '@/features/auth/server/router';
import { createTRPCRouter } from '@/lib/trpc/router';

const userRouter = createUserRouter({});

export const appRouter = createTRPCRouter({
  activities: activitiesRouter,
  user: userRouter,
});
`,
  };

  it('app-router から namespace と router file を引く（local factory も辿る）', () => {
    expect(discoverTrpcRouters(appRouter)).toEqual([
      {
        kind: 'trpc-router',
        id: 'activities',
        path: 'apps/product/src/features/activities/server/router.ts',
        feature: 'activities',
        detail: 'activitiesRouter',
      },
      {
        kind: 'trpc-router',
        id: 'user',
        path: 'apps/product/src/features/auth/server/router.ts',
        feature: 'auth',
        detail: 'userRouter',
      },
    ]);
  });

  it('router file の procedure を namespace 付きで拾い、test / stories は除く', () => {
    const routers = discoverTrpcRouters(appRouter);
    const sources = [
      {
        path: 'apps/product/src/features/activities/server/router.ts',
        text: 'export const activitiesRouter = createTRPCRouter({\n  list: protectedProcedure.query(),\n  create: entitledProcedure.mutation(),\n});',
      },
      {
        path: 'apps/product/src/features/activities/server/router.test.ts',
        text: 'createTRPCRouter({\n  ghost: protectedProcedure,\n})',
      },
    ];
    expect(discoverTrpcProcedures(sources, routers).map((item) => [item.id, item.detail])).toEqual([
      ['activities.list', 'protectedProcedure'],
      ['activities.create', 'entitledProcedure'],
    ]);
  });

  it('MCP registry から tool 名と scope を拾う', () => {
    const registry = {
      path: 'apps/product/src/app/api/mcp/_tools/registry.ts',
      text: "[{ name: 'plans.list', requiredScope: 'read:plans', register: r }, { name: 'plans.create', requiredScope: 'write:plans', register: r }]",
    };
    expect(discoverMcpTools(registry).map((item) => [item.id, item.detail])).toEqual([
      ['plans.list', 'read:plans'],
      ['plans.create', 'write:plans'],
    ]);
    expect(() => discoverMcpTools({ path: 'x.ts', text: '' })).toThrow(/MCP tool/);
  });

  it('feature は path から決まる', () => {
    expect(featureOf('apps/product/src/features/timeblock/server/plans-router.ts')).toBe(
      'timeblock',
    );
    expect(featureOf('apps/product/src/lib/time/x.ts')).toBeUndefined();
  });
});

describe('concept-map: 用語集で意味を付け、未マッピングを炙り出す', () => {
  const entry = (overrides: Partial<GlossaryEntry>): GlossaryEntry => ({
    id: 'x',
    layer: 'ui',
    status: 'current',
    concept: 'X',
    usage: 'u',
    ...overrides,
  });
  const glossary = [
    entry({
      id: 'plan',
      concept: 'Plan',
      code: { feature: 'timeblock' },
      db: ['plans'],
      mcpTools: ['plans.list'],
    }),
    entry({
      id: 'review',
      concept: 'Review',
      code: { feature: 'review', i18nNamespace: 'report' },
    }),
  ];
  const items = [
    { kind: 'feature' as const, id: 'timeblock', path: 'apps/product/src/features/timeblock' },
    { kind: 'feature' as const, id: 'auth', path: 'apps/product/src/features/auth' },
    { kind: 'table' as const, id: 'plans', path: 'supabase/migrations' },
    { kind: 'table' as const, id: 'cron_heartbeats', path: 'supabase/migrations' },
    {
      kind: 'db-function' as const,
      id: 'create_plan_command_v1',
      path: 'supabase/migrations',
      usedBy: ['timeblock'],
    },
    { kind: 'mcp-tool' as const, id: 'plans.list', path: 'registry.ts' },
    { kind: 'mcp-tool' as const, id: 'probe.ping', path: 'registry.ts' },
    {
      kind: 'store' as const,
      id: 'useTimeblockInspectorStore',
      path: 'apps/product/src/features/timeblock/stores/useTimeblockInspectorStore.ts',
      feature: 'timeblock',
    },
    { kind: 'i18n-namespace' as const, id: 'report', path: 'apps/product/messages/en/report.json' },
    {
      kind: 'route' as const,
      id: '/[locale]/calendar',
      path: 'apps/product/src/app/[locale]/(app)/calendar/page.tsx',
    },
  ];
  const map = mapInventoryToConcepts(items, glossary);

  it('直接 / feature 経由 / 未マッピングを分ける', () => {
    const link = (id: string) => map.items.find((item) => item.id === id)?.links;
    expect(link('plans')).toEqual([{ conceptId: 'plan', via: 'direct' }]);
    expect(link('create_plan_command_v1')).toEqual([{ conceptId: 'plan', via: 'feature' }]);
    expect(link('useTimeblockInspectorStore')).toEqual([{ conceptId: 'plan', via: 'feature' }]);
    expect(link('report')).toEqual([{ conceptId: 'review', via: 'direct' }]);
    expect(map.items.filter((item) => item.links.length === 0).map((item) => item.id)).toEqual([
      'auth',
      'cron_heartbeats',
      'probe.ping',
      '/[locale]/calendar',
    ]);
  });

  it('種別ごとの集計を出す', () => {
    expect(summarizeByKind(map).find((s) => s.kind === 'table')).toEqual({
      kind: 'table',
      total: 2,
      direct: 1,
      viaFeature: 0,
      unmapped: 1,
    });
  });

  it('概念図は直接対応だけを描く', () => {
    const diagram = renderConceptDiagram(glossary[0], map.byConcept.get('plan') ?? []);
    expect(diagram).toContain('concept(["Plan<br/>plan"])');
    expect(diagram).toContain('table_plans["DB テーブル<br/>plans"]');
    expect(diagram).toContain('mcp_tool_plans_list["MCP tool<br/>plans.list"]');
    expect(diagram).not.toContain('useTimeblockInspectorStore');
  });
});

describe('likec4-model: Inventory + 用語集 + DAG から LikeC4 model / views を生成する', () => {
  const entry = (overrides: Partial<GlossaryEntry>): GlossaryEntry => ({
    id: 'x',
    layer: 'ui',
    status: 'current',
    concept: 'X',
    usage: 'u',
    ...overrides,
  });
  const glossary = [
    entry({
      id: 'plan',
      concept: 'Plan',
      usage: "it's a plan",
      code: { feature: 'timeblock' },
      db: ['plans'],
    }),
    entry({ id: 'orphan', concept: 'Orphan' }),
  ];
  const schema = parseSchemaModel(SCHEMA_FIXTURE);
  const items = [
    { kind: 'feature' as const, id: 'timeblock', path: 'apps/product/src/features/timeblock' },
    { kind: 'feature' as const, id: 'activities', path: 'apps/product/src/features/activities' },
    { kind: 'table' as const, id: 'plans', path: 'supabase/migrations' },
    { kind: 'table' as const, id: 'activities', path: 'supabase/migrations' },
    { kind: 'mcp-tool' as const, id: 'probe.ping', path: 'registry.ts', detail: 'read:probe' },
    {
      kind: 'story' as const,
      id: 'Product/X',
      path: 'apps/product/src/features/timeblock/X.stories.tsx',
      feature: 'timeblock',
    },
  ];
  const map = mapInventoryToConcepts(items, glossary);
  const dag = buildFeatureDag(parseFeatureRules(ESLINT_FIXTURE), [
    { from: 'timeblock', to: 'activities' },
  ]);
  const sources = { map, glossary, dag, schema };

  it('識別子は種別 prefix 付きで、同名の feature と table が衝突しない', () => {
    expect(likec4Id('f', 'activities')).toBe('f_activities');
    expect(likec4Id('t', 'activities')).toBe('t_activities');
    expect(likec4Id('mcp', 'plans.trash.list')).toBe('mcp_plans_trash_list');
  });

  it('model は対応を持つ概念だけを載せ、未マッピング要素に #unmapped を付け、Story は載せない', () => {
    const model = renderLikeC4Model(sources);
    expect(model).toContain("concept c_plan 'Plan' {");
    expect(model).toContain("description 'it\\'s a plan'");
    expect(model).not.toContain('c_orphan');
    expect(model).toContain("mcptool mcp_probe_ping 'probe.ping' {\n    #unmapped");
    expect(model).not.toContain('Product/X');
    expect(model).toContain("  c_plan -> f_timeblock 'direct'");
    expect(model).toContain("  c_plan -> t_plans 'direct'");
    expect(model).toContain("  f_timeblock -> f_activities 'imports'");
    expect(model).toContain("  t_plans -> t_activities 'FK activity_id, user_id'");
    expect(model).not.toContain('metadata { kind ');
  });

  it('views は固定 view と、直接対応を持つ概念ごとの view を出す', () => {
    const views = renderLikeC4Views(sources);
    for (const name of ['index', 'features', 'data', 'mcp', 'unmapped']) {
      expect(views).toContain(`view ${name} {`);
    }
    expect(views).toContain('view concept_plan of c_plan {');
    expect(views).not.toContain('concept_orphan');
  });
});
