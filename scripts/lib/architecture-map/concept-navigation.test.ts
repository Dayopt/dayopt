import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { GlossaryEntry } from '../glossary/core.ts';
import { mapInventoryToConcepts, renderInventoryDocument } from './concept-map.ts';
import {
  checkNavigationReferences,
  collectConceptNavigation,
  sourceLink,
} from './concept-navigation.ts';
import { renderErDiagram } from './er-diagram.ts';
import type { InventoryItem } from './inventory.ts';
import type { Relations } from './relations.ts';
import { parseSchemaModel } from './schema-model.ts';

const featurePath = 'apps/product/src/features/timeblock';
const story = `${featurePath}/components/Editor.stories.tsx`;
const test = `${featurePath}/server/plan.test.ts`;
const glossary: GlossaryEntry[] = [
  {
    id: 'plan',
    layer: 'code',
    status: 'current',
    concept: 'Plan',
    usage: '予定',
    code: { feature: 'timeblock' },
    db: ['save_plan'],
  },
];
const items: InventoryItem[] = [
  { kind: 'feature', id: 'timeblock', path: featurePath },
  { kind: 'story', id: 'Product/Editor', path: story, feature: 'timeblock' },
  {
    kind: 'route',
    id: '/[locale]/calendar',
    path: 'apps/product/src/app/[locale]/(app)/calendar/page.tsx',
    usedBy: ['timeblock'],
  },
  { kind: 'db-function', id: 'save_plan', path: 'db/types.ts' },
];
const sources = [
  { path: test, text: '' },
  { path: `${featurePath}/components/Editor.tsx`, text: '' },
  { path: story, text: '' },
  { path: 'apps/product/src/features/auth/auth.test.ts', text: '' },
];
const relations: Pick<Relations, 'docCodeLinks' | 'e2eRoutes' | 'dbFunctionTests'> = {
  docCodeLinks: [{ doc: 'docs/plan.md', codePaths: [featurePath], features: ['timeblock'] }],
  e2eRoutes: [{ spec: 'e2e/plan.spec.ts', routes: ['/[locale]/calendar'], unmatched: [] }],
  dbFunctionTests: [{ id: 'save_plan', tests: [test, 'supabase/tests/plan.sql'] }],
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('概念から具体的な候補へ辿る', () => {
  it('所属・画面・DB関数の根拠を保持し、無関係なfeatureを含めず重複をまとめる', () => {
    const map = mapInventoryToConcepts(items, glossary);
    const candidates =
      collectConceptNavigation(map, glossary, sources, relations).get('plan') ?? [];
    expect(candidates.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining([
        test,
        `${featurePath}/components/Editor.tsx`,
        'docs/plan.md',
        'e2e/plan.spec.ts',
        'supabase/tests/plan.sql',
      ]),
    );
    expect(candidates).toHaveLength(5);
    expect(candidates.find((candidate) => candidate.path === test)?.reasons).toEqual([
      'feature: timeblock',
      'DB 関数: save_plan',
    ]);
  });

  it('一覧のStoryと候補のtest/docsが実際のリンクになり、空候補は不要と断定しない', () => {
    const map = mapInventoryToConcepts(items, glossary);
    const navigation = collectConceptNavigation(map, glossary, sources, relations);
    const doc = renderInventoryDocument(map, glossary, '', navigation);
    expect(doc).toContain('[Plan](#concept-plan)');
    expect(doc).toContain('<a id="concept-plan"></a>');
    expect(doc).toContain(sourceLink(story, 'Product/Editor'));
    expect(doc).toContain(sourceLink(test));
    expect(doc).toContain(sourceLink('docs/plan.md'));
    expect(renderInventoryDocument(map, glossary, '')).toContain(
      '未使用・検証不要という意味ではありません',
    );
  });

  it('独自APIを持たないCalendarから依存先のPlanへ辿れるが、架空の概念リンクは出さない', () => {
    const terms: GlossaryEntry[] = [
      ...glossary,
      {
        id: 'calendar-surface',
        layer: 'code',
        status: 'current',
        concept: 'Calendar',
        usage: '画面',
        code: { feature: 'calendar' },
      },
    ];
    const map = mapInventoryToConcepts(
      [...items, { kind: 'feature', id: 'calendar', path: 'apps/product/src/features/calendar' }],
      terms,
    );
    const doc = renderInventoryDocument(map, terms, '', new Map(), [
      { from: 'calendar', to: 'timeblock' },
      { from: 'calendar', to: 'missing' },
    ]);
    const calendar = doc.split('<a id="concept-calendar-surface"></a>')[1];
    expect(calendar).toContain('依存先の概念');
    expect(calendar).toContain('[Plan](#concept-plan)');
    expect(calendar).not.toContain('#concept-missing');
  });

  it('括弧・locale・空白を含むpathをMarkdownリンクとして壊さない', () => {
    expect(sourceLink('apps/[locale]/(app)/My File.tsx', 'UI')).toBe(
      '[UI](<../../../apps/[locale]/(app)/My File.tsx>)',
    );
  });

  it('Story/testのrenameとdeleteで古い参照を検出し、再収集後は旧リンクが消える', () => {
    const root = mkdtempSync(join(tmpdir(), 'architecture-navigation-'));
    roots.push(root);
    const map = mapInventoryToConcepts(items, glossary);
    const navigation = collectConceptNavigation(map, glossary, sources, relations);
    const paths = new Set([
      ...items.map((item) => item.path),
      ...[...navigation.values()].flat().map((candidate) => candidate.path),
    ]);
    mkdirSync(join(root, featurePath), { recursive: true });
    for (const path of paths) {
      if (path === featurePath) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), '');
    }
    expect(checkNavigationReferences(root, map, navigation)).toEqual([]);
    renameSync(join(root, story), join(root, story.replace('Editor', 'Renamed')));
    rmSync(join(root, test));
    const violations = checkNavigationReferences(root, map, navigation);
    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.reason).join('\n')).toContain(story);
    expect(violations.map((violation) => violation.reason).join('\n')).toContain(test);
    const newItems = items.map((item) =>
      item.path === story ? { ...item, path: story.replace('Editor', 'Renamed') } : item,
    );
    const newMap = mapInventoryToConcepts(newItems, glossary);
    const newRelations = {
      ...relations,
      dbFunctionTests: [{ id: 'save_plan', tests: ['supabase/tests/plan.sql'] }],
    };
    const newNavigation = collectConceptNavigation(
      newMap,
      glossary,
      sources.filter((file) => file.path !== test),
      newRelations,
    );
    const before = renderInventoryDocument(map, glossary, '', navigation);
    const after = renderInventoryDocument(newMap, glossary, '', newNavigation);
    expect(after).not.toBe(before);
    expect(after).not.toContain(sourceLink(test));
    expect(after).not.toContain(sourceLink(story, 'Product/Editor'));
    expect(after).toContain(sourceLink(story.replace('Editor', 'Renamed'), 'Product/Editor'));
    expect(checkNavigationReferences(root, newMap, newNavigation)).toEqual([]);
    expect(renderInventoryDocument(newMap, glossary, '', newNavigation)).toBe(after);
  });

  it('schemaの列/FK変更がERへ反映され、入力が同じなら同じ図になる', () => {
    const schema = `export type Database = { public: { Tables: {
      activities: { Row: { id: string }; Relationships: [] };
      plans: { Row: { id: string; activity_id: string }; Relationships: [] };
    }; Functions: {} } }`;
    const before = renderErDiagram(parseSchemaModel(schema));
    const changed = schema
      .replace('id: string; activity_id:', 'id: string; note: string; activity_id:')
      .replace(
        'activity_id: string }; Relationships: []',
        'activity_id: string }; Relationships: [{ foreignKeyName: "plans_activity_fkey"; columns: ["activity_id"]; referencedRelation: "activities"; referencedColumns: ["id"]; isOneToOne: false }]',
      );
    const after = renderErDiagram(parseSchemaModel(changed));
    expect(after).not.toBe(before);
    expect(after).toContain('note');
    expect(after).toContain('FK');
    expect(after).toContain('plans }o--|| activities : "activity_id"');
    expect(renderErDiagram(parseSchemaModel(changed))).toBe(after);
  });
});
