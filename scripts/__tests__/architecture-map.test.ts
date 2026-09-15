import { describe, expect, it } from 'vitest';

import {
  renderErDiagram,
  renderTableIndex,
  toMermaidType,
} from '../lib/architecture-map/er-diagram.ts';
import {
  architectureMapMarkers,
  replaceGeneratedBlock,
} from '../lib/architecture-map/generated-block.ts';
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
