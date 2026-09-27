import { describe, expect, it } from 'vitest';

import {
  attributeRoutesByCallGraph,
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
  collectDatabaseUsers,
  discoverMcpTools,
  discoverTrpcProcedures,
  discoverTrpcRouters,
  featureOf,
  type InventoryItem,
  parseTableAliases,
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
import {
  collectFeatureCoverage,
  collectMcpToolProcedures,
  collectProcedureUsage,
  normalizeGotoUrl,
  parseFrontmatterCodePaths,
} from '../lib/architecture-map/relations.ts';
import { parseSchemaModel } from '../lib/architecture-map/schema-model.ts';
import {
  discoverHttpRoutes,
  foldPgCronJobs,
  parseAnalyticsEventCheck,
  parseAnalyticsEventNames,
  parseMcpTrpcScopeRequirements,
  parseProcedureBuilders,
  parseRateLimits,
  parseRouteMethods,
  parseSupabaseConfig,
  parseSupportedScopes,
  parseWorkflowSchedules,
  routeUrlOf,
} from '../lib/architecture-map/surface.ts';
import {
  parseTimeRulesSection,
  renderTimeRulesDiagram,
} from '../lib/architecture-map/time-rules.ts';
import {
  checkVocabularyScopeDeclarations,
  vocabularyExclusionReason,
} from '../lib/architecture-map/vocabulary-scope.ts';
import type { GlossaryEntry } from '../lib/glossary/core.ts';
import {
  buildProductCallGraph,
  checkArchitectureReferences,
  findStaleArchitectureMapDocs,
} from '../tasks/generate-architecture-map.ts';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverInventory } from '../lib/architecture-map/inventory.ts';
import { collectProductSources } from '../lib/architecture-map/references.ts';
import { collectRelations } from '../lib/architecture-map/relations.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('種別ごとの集計を出す。語彙を持たない層は候補と別に数える', () => {
    // cron_heartbeats は usedBy が無い = app から触らないテーブルなので語彙対象外へ落ちる
    expect(summarizeByKind(map).find((s) => s.kind === 'table')).toEqual({
      kind: 'table',
      total: 2,
      direct: 1,
      viaFeature: 0,
      unmapped: 0,
      outOfScope: 1,
    });
  });

  it('概念図は直接対応だけを描く', () => {
    const diagram = renderConceptDiagram(glossary[0], map.byConcept.get('plan') ?? []);
    expect(diagram).toContain('concept(["Plan<br/>plan"])');
    expect(diagram).toContain('table_plans["DB テーブル<br/>plans"]');
    expect(diagram).toContain('mcp_tool_plans_list["MCP tool<br/>plans.list"]');
    expect(diagram).not.toContain('useTimeblockInspectorStore');
  });

  it('画面は call graph が出した procedure から feature を得て概念へ繋がる', () => {
    const withProcedure = [
      ...items,
      {
        kind: 'trpc-procedure' as const,
        id: 'plans.list',
        path: 'apps/product/src/features/timeblock/server/plans-router.ts',
        feature: 'timeblock',
      },
    ];
    const attributed = attributeRoutesByCallGraph(withProcedure, [
      { route: '/[locale]/calendar', procedures: ['plans.list'] },
    ]);
    const route = attributed.find((item) => item.id === '/[locale]/calendar');
    expect(route?.usedBy).toEqual(['timeblock']);
    // usedBy が付いた結果、用語集の timeblock 概念（plan）へ feature 経由で辿れる
    const linked = mapInventoryToConcepts(attributed, glossary).items.find(
      (item) => item.id === '/[locale]/calendar',
    );
    expect(linked?.links).toEqual([{ conceptId: 'plan', via: 'feature' }]);
  });

  it('procedure が解決できない画面は据え置く（推測で feature を付けない）', () => {
    const attributed = attributeRoutesByCallGraph(items, [
      { route: '/[locale]/calendar', procedures: ['unknown.procedure'] },
    ]);
    expect(attributed.find((item) => item.id === '/[locale]/calendar')?.usedBy).toBeUndefined();
  });
});

describe('vocabulary-scope: 概念が付かないことが正しい項目を分ける', () => {
  const item = (overrides: Partial<InventoryItem> & Pick<InventoryItem, 'kind' | 'id'>) => ({
    path: 'x',
    ...overrides,
  });

  it('app から呼ばれない DB 関数は SQL 内部として除外する', () => {
    expect(vocabularyExclusionReason(item({ kind: 'db-function', id: 'assert_x_v1' }))).toContain(
      'SQL 内部',
    );
  });

  it('利用元が app / lib だけの DB 関数は基盤として除外する', () => {
    expect(
      vocabularyExclusionReason(
        item({ kind: 'db-function', id: 'claim_x_v1', usedBy: ['app', 'lib'] }),
      ),
    ).toContain('feature 横断の基盤');
  });

  it('feature から使われる DB 関数は候補に残す（概念を足せば繋がるため）', () => {
    expect(
      vocabularyExclusionReason(
        item({ kind: 'db-function', id: 'claim_x_v1', usedBy: ['settings'] }),
      ),
    ).toBeUndefined();
  });

  it('認証 / OAuth の画面は下位 route まで除外する', () => {
    expect(
      vocabularyExclusionReason(item({ kind: 'route', id: '/[locale]/auth/login' })),
    ).toContain('認証');
    expect(
      vocabularyExclusionReason(item({ kind: 'route', id: '/[locale]/calendar' })),
    ).toBeUndefined();
  });

  it('feature に属さない Story だけを除外する', () => {
    expect(
      vocabularyExclusionReason(item({ kind: 'story', id: 'Product/Components/Ui' })),
    ).toContain('共通 UI');
    expect(
      vocabularyExclusionReason(
        item({ kind: 'story', id: 'Product/Calendar', feature: 'calendar' }),
      ),
    ).toBeUndefined();
  });

  it('実装から消えた宣言を検出する', () => {
    // common / email などを 1 つも持たない inventory を渡すと、宣言が残っていることを報せる
    const errors = checkVocabularyScopeDeclarations([
      item({ kind: 'i18n-namespace', id: 'common' }),
      item({ kind: 'route', id: '/[locale]' }),
      item({ kind: 'route', id: '/[locale]/auth' }),
      item({ kind: 'route', id: '/[locale]/oauth' }),
      item({ kind: 'route', id: '/offline' }),
    ]);
    expect(errors.some((error) => error.includes("'legal'"))).toBe(true);
    expect(errors.some((error) => error.includes("'common'"))).toBe(false);
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
  const surface = {
    httpRoutes: [
      {
        id: '/api/cron/calendar-sync',
        app: 'product' as const,
        methods: ['GET'],
        path: 'apps/product/src/app/api/cron/calendar-sync/route.ts',
      },
    ],
    schedules: [
      {
        id: '/api/cron/calendar-sync',
        source: 'vercel' as const,
        schedule: '*/15 * * * *',
        target: '/api/cron/calendar-sync',
        path: 'apps/product/vercel.json',
        authoritative: true,
      },
    ],
    supabase: [],
    errorCodes: [],
    scopes: [],
    rateLimits: [],
    procedureBuilders: [],
    analyticsEvents: [],
    envVars: [],
    packages: [],
  };
  const relations = {
    procedureUsage: [],
    unusedProcedures: [],
    mcpToolProcedures: [],
    mcpToolFiles: new Map<string, string>(),
    storeUsage: [],
    docCodeLinks: [],
    e2eRoutes: [],
    dbFunctionTests: [],
    featureCoverage: [],
  };
  const callGraph = {
    procedures: [
      { id: 'plans.list', tables: ['plans'], functions: [] },
      { id: 'plans.create', tables: [], functions: ['create_plan_command_v1'] },
    ],
    mcpTools: [],
    pages: [],
  };
  const sources = { map, glossary, dag, schema, surface, relations, callGraph };

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

  it('HTTP route と定期実行を載せ、cron から route へ triggers を引く', () => {
    const model = renderLikeC4Model(sources);
    expect(model).toContain("httproute h_product_api_cron_calendar-sync '/api/cron/calendar-sync'");
    expect(model).toContain("metadata { app 'product' methods 'GET' }");
    expect(model).toContain(
      "  cron_vercel__api_cron_calendar-sync -> h_product_api_cron_calendar-sync 'triggers'",
    );
  });

  it('procedure の DB アクセスを router 単位へ集約して関係を引く', () => {
    const model = renderLikeC4Model({
      ...sources,
      map: mapInventoryToConcepts(
        [
          ...items,
          {
            kind: 'trpc-router' as const,
            id: 'plans',
            path: 'x/plans-router.ts',
            feature: 'timeblock',
          },
          {
            kind: 'db-function' as const,
            id: 'create_plan_command_v1',
            path: 'supabase/migrations',
          },
        ],
        glossary,
      ),
    });
    expect(model).toContain("  r_plans -> t_plans 'reads'");
    expect(model).toContain("  r_plans -> fn_create_plan_command_v1 'calls'");
  });

  it('views は固定 view と、直接対応を持つ概念ごとの view を出す', () => {
    const views = renderLikeC4Views(sources);
    for (const name of ['index', 'features', 'data', 'mcp', 'api', 'unmapped']) {
      expect(views).toContain(`view ${name} {`);
    }
    expect(views).toContain('view concept_plan of c_plan {');
    expect(views).not.toContain('concept_orphan');
  });
});

describe('inventory: 取りこぼしていた形を拾う', () => {
  const appRouter = {
    path: 'apps/product/src/app/api/trpc/_server/app-router.ts',
    text: `
import { createUserRouter } from '@/features/auth/server/router';
import { statisticsRouter } from '@/features/timeblock/server/router-index';
import { createTRPCRouter } from '@/lib/trpc/router';

const userRouter = createUserRouter({});

export const appRouter = createTRPCRouter({
  statistics: statisticsRouter,
  user: userRouter,
});
`,
  };
  const sources = [
    appRouter,
    {
      // 関数の中で組み立てる router（インデントが 2 space ではない）
      path: 'apps/product/src/features/auth/server/router.ts',
      text: `export function createUserRouter(dependencies) {
  return createTRPCRouter({
    deleteAccount: protectedProcedure.mutation(async () => {}),
    exportData: protectedProcedure.query(async () => {}),
  });
}`,
    },
    {
      // namespace を持つ file は mergeRouters 経由の 2 hop 先にある
      path: 'apps/product/src/features/timeblock/server/router-index.ts',
      text: "import { statisticsQueriesRouter } from './statistics';\nexport const statisticsRouter = statisticsQueriesRouter;",
    },
    {
      path: 'apps/product/src/features/timeblock/server/statistics.ts',
      text: "import { statisticsKpiRouter } from './statistics-kpi-router';\nexport const statisticsQueriesRouter = mergeRouters(statisticsKpiRouter);",
    },
    {
      // const 経由で登録する procedure（deprecated alias を含む）
      path: 'apps/product/src/features/timeblock/server/statistics-kpi-router.ts',
      text: `const activityEstimationFactors = protectedProcedure.query(async () => {});

export const statisticsKpiRouter = createTRPCRouter({
  getActivityEstimationFactors: activityEstimationFactors,
  getTagEstimationFactors: activityEstimationFactors,
});`,
    },
  ];

  it('インデントに依存せず、mergeRouters の先まで namespace を伝播する', () => {
    const routers = discoverTrpcRouters(appRouter);
    const procedures = discoverTrpcProcedures(sources, routers).map((item) => item.id);
    expect(procedures).toEqual([
      'user.deleteAccount',
      'user.exportData',
      'statistics.getActivityEstimationFactors',
      'statistics.getTagEstimationFactors',
    ]);
  });

  it('.rpc(定数) と .from(databaseTables.x) を拾い、テーブル以外の .from は拾わない', () => {
    const files = [
      {
        path: 'apps/product/src/lib/database/tables.ts',
        text: "export const databaseTables = {\n  plans: 'plans',\n  userSettings: 'user_settings',\n} as const;",
      },
      {
        path: 'apps/product/src/features/timeblock/server/service.ts',
        text: `const CLAIM_STEP_RPC = 'create_plan_command_v1';
await admin.rpc(CLAIM_STEP_RPC, {});
await admin.rpc<Row>('update_plan_command_v1', {});
await admin.from(databaseTables.plans).select();
await admin.from('user_settings').select();
await supabase.storage.from('avatars').upload();
Array.from('abc');`,
      },
    ];
    const users = collectDatabaseUsers(
      files,
      parseTableAliases(files),
      new Set(['plans', 'user_settings']),
    );
    expect([...users.rpc.keys()].sort()).toEqual([
      'create_plan_command_v1',
      'update_plan_command_v1',
    ]);
    expect([...users.table.keys()].sort()).toEqual(['plans', 'user_settings']);
    expect([...(users.table.get('plans') ?? [])]).toEqual(['timeblock']);
  });
});

describe('surface: 運用面の発見', () => {
  it('route.ts の method は再 export 形も拾う', () => {
    expect(parseRouteMethods('export { handler as GET, handler as POST };')).toEqual([
      'GET',
      'POST',
    ]);
    expect(parseRouteMethods("export { DELETE, GET, POST } from '@/app/api/mcp/route';")).toEqual([
      'GET',
      'POST',
      'DELETE',
    ]);
    expect(
      parseRouteMethods('export async function GET() {}\nexport const runtime = "edge";'),
    ).toEqual(['GET']);
  });

  it('route group を除いた URL を作る', () => {
    expect(routeUrlOf('apps/product/src/app/[locale]/(auth)/auth/callback/route.ts')).toBe(
      '/[locale]/auth/callback',
    );
    expect(routeUrlOf('apps/product/src/app/.well-known/oauth-protected-resource/route.ts')).toBe(
      '/.well-known/oauth-protected-resource',
    );
  });

  it('route.tsx も HTTP route として発見する', () => {
    expect(
      discoverHttpRoutes(REPO_ROOT).find(
        (route) => route.path === 'apps/web/src/app/api/og/route.tsx',
      ),
    ).toMatchObject({ app: 'web', id: '/api/og' });
  });

  it('pg_cron は schedule / unschedule を migration 順に畳む', () => {
    const jobs = foldPgCronJobs([
      {
        path: 'supabase/migrations/001_a.sql',
        text: "select cron.schedule('cleanup-login-attempts', '0 3 * * *', $$select 1$$);",
      },
      {
        path: 'supabase/migrations/002_b.sql',
        text: "select cron.schedule(\n  'expire-outbox',\n  '* * * * *',\n  $$select 1$$\n);",
      },
      {
        path: 'supabase/migrations/003_c.sql',
        text: "select cron.unschedule('cleanup-login-attempts');",
      },
    ]);
    expect([...jobs.keys()]).toEqual(['expire-outbox']);
    expect(jobs.get('expire-outbox')?.schedule).toBe('* * * * *');
  });

  it('workflow の on.schedule だけを読む（他の schedule: 行は読まない）', () => {
    const yaml = `on:
  schedule:
    # 毎朝
    - cron: '30 19 * * *'
    - cron: '0 22 * * *'
  workflow_dispatch:
jobs:
  build:
    steps:
      - run: echo schedule:
`;
    expect(parseWorkflowSchedules(yaml)).toEqual(['30 19 * * *', '0 22 * * *']);
  });

  it('config.toml から Edge Function / auth hook / bucket を読む', () => {
    const toml = `[storage.buckets.avatars]
public = false

[auth.hook.send_email]
enabled = true
uri = "https://example"

[functions.send-auth-email]
verify_jwt = false
`;
    expect(parseSupabaseConfig(toml)).toEqual([
      { kind: 'storage-bucket', id: 'avatars' },
      { kind: 'auth-hook', id: 'send_email', detail: 'enabled' },
      { kind: 'edge-function', id: 'send-auth-email' },
    ]);
  });

  it('scope / rate limit / builder / 分析イベントを読む', () => {
    expect(
      parseSupportedScopes(
        "export const SUPPORTED_SCOPES = [\n  'read:entries',\n  'write:plans',\n] as const;",
      ),
    ).toEqual(['read:entries', 'write:plans']);
    expect(
      parseMcpTrpcScopeRequirements(
        "const MCP_TRPC_SCOPE_REQUIREMENTS: Partial<Record<string, SupportedScope>> = {\n  'plans.list': 'read:entries',\n};\n",
      ).get('plans.list'),
    ).toBe('read:entries');
    expect(
      parseRateLimits(
        "export const trpcUserRateLimit = createRateLimiter(\n  Ratelimit.slidingWindow(300, '1 m'),\n  'trpc',\n);",
      ),
    ).toEqual([{ id: 'trpcUserRateLimit', limit: 300, window: '1 m' }]);
    expect(
      parseProcedureBuilders(
        'export const protectedProcedure = t.procedure\nexport function entitledProcedure(key) {}',
      ),
    ).toEqual(['protectedProcedure', 'entitledProcedure']);
    expect(
      parseAnalyticsEventNames(
        "export const PRODUCT_EVENT_NAMES = [\n  'user_signed_up',\n] as const;",
      ),
    ).toEqual(['user_signed_up']);
    expect(
      parseAnalyticsEventCheck([
        {
          path: 'supabase/migrations/001_a.sql',
          text: "ALTER TABLE public.product_events ADD CONSTRAINT product_events_event_name_check CHECK (\n  event_name IN ('user_signed_up', 'plan_created')\n);",
        },
      ]),
    ).toEqual(['user_signed_up', 'plan_created']);
  });
});

describe('relations: 呼び出し関係', () => {
  const procedures = [
    { kind: 'trpc-procedure' as const, id: 'plans.list', path: 'x/server/plans-router.ts' },
    {
      kind: 'trpc-procedure' as const,
      id: 'billing.getLegacyInvoices',
      path: 'x/server/billing-router.ts',
    },
    {
      kind: 'trpc-procedure' as const,
      id: 'activities.listActivities',
      path: 'x/server/router.ts',
    },
  ];

  it('client / MCP の呼び出し元を分け、未使用を出す', () => {
    const sources = [
      {
        path: 'apps/product/src/features/calendar/hooks/useCalendarData.ts',
        text: 'const { data } = api.plans.list.useQuery();\nutils.plans.list.invalidate();',
      },
      {
        path: 'apps/product/src/app/api/mcp/_tools/activities-list.ts',
        text: 'const rows = await trpc.activities.listActivities({});',
      },
      {
        path: 'apps/product/src/features/settings/components/BillingSettings.stories.tsx',
        text: 'api.billing.getLegacyInvoices.useQuery();',
      },
      {
        path: 'apps/product/src/features/settings/server/billing-router.ts',
        text: 'export const billingRouter = createTRPCRouter({ getLegacyInvoices: protectedProcedure });',
      },
    ];
    const { usage, unused } = collectProcedureUsage(sources, procedures);
    const byId = new Map(usage.map((item) => [item.id, item]));
    expect(byId.get('plans.list')?.callers.app).toHaveLength(1);
    expect(byId.get('activities.listActivities')?.callers.mcp).toHaveLength(1);
    // Story と router 定義そのものは呼び出し元に数えない
    expect(unused).toEqual(['billing.getLegacyInvoices']);
  });

  it('MCP registry の tool を file へ束ね、その file が呼ぶ procedure を出す', () => {
    const sources = [
      {
        path: 'apps/product/src/app/api/mcp/_tools/registry.ts',
        text: `import { registerPlansListTool, registerRecordsListTool } from './timeblock-list';

export const MCP_TOOL_DESCRIPTORS = [
  { name: 'plans.list', requiredScope: 'read:entries', register: registerPlansListTool },
  { name: 'records.list', requiredScope: 'read:entries', register: registerRecordsListTool },
];`,
      },
      {
        path: 'apps/product/src/app/api/mcp/_tools/timeblock-list.ts',
        text: 'const plans = await trpc.plans.list({});\nconst records = await trpc.records.list({});',
      },
    ];
    expect(collectMcpToolProcedures(sources)).toEqual([
      {
        path: 'apps/product/src/app/api/mcp/_tools/timeblock-list.ts',
        tools: ['plans.list', 'records.list'],
        procedures: ['plans.list', 'records.list'],
      },
    ]);
  });

  it('frontmatter の code: を scalar / 配列の両方で読む', () => {
    expect(
      parseFrontmatterCodePaths('---\nstatus: current\ncode: apps/product/src\n---\n本文'),
    ).toEqual(['apps/product/src']);
    expect(
      parseFrontmatterCodePaths(
        '---\ncode:\n  - apps/product/src/features/timeblock\n  - scripts/ci\nstatus: current\n---\n',
      ),
    ).toEqual(['apps/product/src/features/timeblock', 'scripts/ci']);
    expect(parseFrontmatterCodePaths('# frontmatter なし')).toEqual([]);
  });

  it('page.goto の URL から locale と query を落とす', () => {
    expect(normalizeGotoUrl('/ja/calendar?view=day&date=2026-01-01')).toBe('/calendar');
    expect(normalizeGotoUrl('/en/auth/login')).toBe('/auth/login');
    expect(normalizeGotoUrl('/ja')).toBe('/');
    // query の中の変数は無視して path だけ見る（E2E は日付を変数で渡す）
    expect(normalizeGotoUrl('/ja/calendar?date=${PAST_DATE}')).toBe('/calendar');
    // path 自体が変数なら route へ寄せない
    expect(normalizeGotoUrl('/ja/${slug}/edit')).toBeUndefined();
    expect(normalizeGotoUrl('https://attacker.example')).toBeUndefined();
  });

  it('feature ごとの test / Story 被覆を数える', () => {
    const sources = [
      {
        path: 'apps/product/src/features/calendar/components/DayView.tsx',
        text: 'export function DayView() {}',
      },
      {
        path: 'apps/product/src/features/calendar/components/DayView.stories.tsx',
        text: 'const meta = {};',
      },
      {
        path: 'apps/product/src/features/calendar/components/WeekView.tsx',
        text: 'export function WeekView() {}',
      },
      {
        path: 'apps/product/src/features/calendar/lib/overlap.ts',
        text: 'export function overlap() {}',
      },
      {
        path: 'apps/product/src/features/calendar/lib/overlap.test.ts',
        text: 'it("works", () => {});',
      },
    ];
    expect(collectFeatureCoverage(sources)).toEqual([
      {
        feature: 'calendar',
        sourceFiles: 3,
        testFiles: 1,
        components: 2,
        componentsWithStory: 1,
      },
    ]);
  });
});

describe('call-graph: 型チェッカーで呼び出し経路を辿る', () => {
  /**
   * 実 repo に対して 1 回だけ program を作る（約 2 秒）。fixture では DI や条件分岐の解決を
   * 再現できないため、ここでは実装そのものを対象に「解決できていること」を固定する。
   */
  const sources = collectProductSources(REPO_ROOT);
  const schema = parseSchemaModel(
    readFileSync(`${REPO_ROOT}/apps/product/src/lib/database/generated/database.types.ts`, 'utf8'),
  );
  const items = discoverInventory(REPO_ROOT, sources, schema);
  const relations = collectRelations(REPO_ROOT, sources, items);
  const graph = buildProductCallGraph(items, sources, schema, relations.mcpToolFiles);

  it('DI 経由（service → client → rpc）の procedure を解決する', () => {
    const create = graph.procedures.find((procedure) => procedure.id === 'planCommands.create');
    // router → createTimeblockCommandService → 既定引数で注入される client → rpc
    expect(create?.functions).toContain('create_plan_command_v1');
  });

  it('service が直接 .from() するテーブルを解決する', () => {
    const list = graph.procedures.find((procedure) => procedure.id === 'activities.listActivities');
    expect(list?.tables).toContain('activities');
  });

  it('DB を触らない procedure は載せない', () => {
    const ids = new Set(graph.procedures.map((procedure) => procedure.id));
    // 定数を返すだけの procedure（DB アクセスなし）
    expect(ids.has('timeblockContext.getConstraints')).toBe(false);
  });

  it('MCP の書き込み tool は apply_mcp_* を通る', () => {
    const create = graph.mcpTools.find((tool) => tool.tool === 'plans.create');
    expect(create?.functions.some((fn) => fn.startsWith('apply_mcp_'))).toBe(true);
  });

  it('画面から使う procedure は barrel を辿らず宣言元で絞る', () => {
    const calendar = graph.pages.find((page) => page.route.endsWith('/calendar'));
    expect(calendar?.procedures).toContain('plans.list');
    expect(calendar?.procedures).toContain('statistics.getActivityStats');
    // calendar から billing / MCP 設定の procedure は使わない（barrel 経由で混ざらないこと）
    expect(calendar?.procedures.some((id) => id.startsWith('billing.'))).toBe(false);
    expect(calendar?.procedures.some((id) => id.startsWith('mcpConnections.'))).toBe(false);
  });
}, 120_000);
