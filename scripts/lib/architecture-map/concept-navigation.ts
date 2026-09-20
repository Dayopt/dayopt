/** 概念別の探索候補。依存の証明ではなく、既存の所属・参照情報を辿る入口。 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { relative } from 'node:path/posix';

import type { GlossaryEntry } from '../glossary/core.ts';
import type { ConceptMap } from './concept-map.ts';
import { featureOf } from './inventory.ts';
import type { ReferenceViolation, SourceFile } from './references.ts';
import type { Relations } from './relations.ts';

export interface NavigationCandidate {
  path: string;
  kind: 'UI' | 'test' | 'docs';
  reasons: string[];
}

export type ConceptNavigation = Map<string, NavigationCandidate[]>;

export function conceptAnchor(id: string): string {
  return `concept-${id}`;
}

/** GitHub と Markdown preview の両方で、括弧や空白を含む path も辿れる。 */
export function sourceLink(path: string, label = path): string {
  const href = relative('docs/engineering/data', path);
  const escapedLabel = label.replace(/[\\\[\]`|]/g, (char) => `\\${char}`);
  return `[${escapedLabel}](<${href}>)`;
}

export function collectConceptNavigation(
  map: ConceptMap,
  glossary: readonly GlossaryEntry[],
  sources: readonly SourceFile[],
  relations: Pick<Relations, 'docCodeLinks' | 'e2eRoutes' | 'dbFunctionTests'>,
): ConceptNavigation {
  const result: ConceptNavigation = new Map();
  for (const entry of glossary) {
    const items = map.byConcept.get(entry.id) ?? [];
    if (items.length === 0) continue;
    const candidates = new Map<string, NavigationCandidate>();
    const add = (kind: NavigationCandidate['kind'], path: string, reason: string): void => {
      const key = `${kind}:${path}`;
      const candidate = candidates.get(key) ?? { kind, path, reasons: [] };
      if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
      candidates.set(key, candidate);
    };
    // 概念が名指す feature の所属だけを使う。他の候補の feature へ再帰的に広げない。
    const feature = entry.code?.feature;
    if (feature !== undefined) {
      for (const file of sources) {
        if (featureOf(file.path) !== feature) continue;
        if (/\.test\.tsx?$/.test(file.path)) add('test', file.path, `feature: ${feature}`);
        else if (/\/components\/.*\.tsx$/.test(file.path) && !/\.stories\.tsx$/.test(file.path))
          add('UI', file.path, `feature: ${feature}`);
      }
      for (const doc of relations.docCodeLinks) {
        if (doc.features.includes(feature)) add('docs', doc.doc, `frontmatter code: ${feature}`);
      }
    }
    const routes = new Set(items.filter((item) => item.kind === 'route').map((item) => item.id));
    for (const e2e of relations.e2eRoutes) {
      for (const route of e2e.routes) {
        if (routes.has(route)) add('test', e2e.spec, `画面: ${route}`);
      }
    }
    const functions = new Set(
      items.filter((item) => item.kind === 'db-function').map((item) => item.id),
    );
    for (const dbTest of relations.dbFunctionTests) {
      if (!functions.has(dbTest.id)) continue;
      for (const path of dbTest.tests) add('test', path, `DB 関数: ${dbTest.id}`);
    }
    result.set(
      entry.id,
      [...candidates.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path),
      ),
    );
  }
  return result;
}

export function checkNavigationReferences(
  root: string,
  map: ConceptMap,
  navigation: ConceptNavigation,
): ReferenceViolation[] {
  const paths = new Set(map.items.map((item) => item.path));
  for (const candidates of navigation.values()) {
    for (const candidate of candidates) paths.add(candidate.path);
  }
  return [...paths]
    .sort()
    .filter((path) => !existsSync(resolve(root, path)))
    .map((path) => ({
      source: 'architecture-navigation',
      reason: `参照先がありません: ${path}`,
    }));
}

export function renderConceptNavigation(candidates: readonly NavigationCandidate[]): string[] {
  const out: string[] = [];
  for (const kind of ['UI', 'test', 'docs'] as const) {
    const rows = candidates.filter((candidate) => candidate.kind === kind);
    out.push('<details>', `<summary>${kind} の候補（${rows.length}）</summary>`, '');
    if (rows.length === 0)
      out.push(
        '既存の対応情報からは候補を発見できませんでした。未使用・検証不要という意味ではありません。',
        '',
      );
    else {
      out.push('<!-- prettier-ignore -->', '| ファイル | 対応の根拠 |', '| --- | --- |');
      for (const row of rows) out.push(`| ${sourceLink(row.path)} | ${row.reasons.join(' / ')} |`);
      out.push('');
    }
    out.push('</details>', '');
  }
  return out;
}
