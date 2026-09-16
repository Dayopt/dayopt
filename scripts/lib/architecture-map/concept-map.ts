/**
 * 概念 ↔ Inventory の対応付け（意味の層）と、その可視化。
 *
 * 対応の正本は用語集（`scripts/lib/glossary/terms.ts`）。ここでは新しい対応表を持たず、
 * 用語集の `code.feature` / `code.i18nNamespace` / `db` / `mcpTools` から機械的に引く。
 *
 *   直接（direct）   … 用語集がその item を名指ししている
 *   feature 経由     … item の所属 feature を名指しする概念がある（router / procedure / store / story）
 *   未マッピング     … どの概念も辿り着かない。人間が用語集へ 1 行足すか、消すかを判断する対象
 */

import type { GlossaryEntry } from '../glossary/core.ts';
import {
  INVENTORY_KIND_LABELS,
  INVENTORY_KINDS,
  type InventoryItem,
  type InventoryKind,
} from './inventory.ts';
import { vocabularyExclusionReason } from './vocabulary-scope.ts';

export interface ConceptLink {
  conceptId: string;
  via: 'direct' | 'feature';
}

export interface MappedItem extends InventoryItem {
  links: ConceptLink[];
}

export interface ConceptMap {
  items: MappedItem[];
  /** concept id → 直接 / feature 経由で辿れる item */
  byConcept: Map<string, MappedItem[]>;
}

function conceptsOfFeature(glossary: readonly GlossaryEntry[], feature: string): string[] {
  return glossary.filter((entry) => entry.code?.feature === feature).map((entry) => entry.id);
}

function directConcepts(glossary: readonly GlossaryEntry[], item: InventoryItem): string[] {
  const ids: string[] = [];
  for (const entry of glossary) {
    let hit = false;
    switch (item.kind) {
      case 'feature':
        hit = entry.code?.feature === item.id;
        break;
      case 'table':
        hit = (entry.db ?? []).some((ref) => ref === item.id || ref.startsWith(`${item.id}.`));
        break;
      case 'db-function':
        hit = (entry.db ?? []).includes(item.id);
        break;
      case 'mcp-tool':
        hit = (entry.mcpTools ?? []).includes(item.id);
        break;
      case 'i18n-namespace':
        hit = entry.code?.i18nNamespace === item.id;
        break;
      default:
        hit = false;
    }
    if (hit) ids.push(entry.id);
  }
  return ids;
}

export function mapInventoryToConcepts(
  items: InventoryItem[],
  glossary: readonly GlossaryEntry[],
): ConceptMap {
  const mapped: MappedItem[] = items.map((item) => {
    const links: ConceptLink[] = directConcepts(glossary, item).map((conceptId) => ({
      conceptId,
      via: 'direct',
    }));
    const viaFeatures = [
      ...(item.feature !== undefined && item.kind !== 'feature' ? [item.feature] : []),
      ...(item.usedBy ?? []),
    ];
    for (const feature of viaFeatures) {
      for (const conceptId of conceptsOfFeature(glossary, feature)) {
        if (!links.some((link) => link.conceptId === conceptId)) {
          links.push({ conceptId, via: 'feature' });
        }
      }
    }
    return { ...item, links };
  });

  const byConcept = new Map<string, MappedItem[]>();
  for (const entry of glossary) byConcept.set(entry.id, []);
  for (const item of mapped) {
    for (const link of item.links) byConcept.get(link.conceptId)?.push(item);
  }
  return { items: mapped, byConcept };
}

/**
 * 画面（route）に利用元 feature を付ける。
 *
 * route は file 位置からも用語集からも feature が決まらないので、素のままでは 16 件全部が
 * 未マッピングへ落ちる。call graph が出した「画面 → 使う procedure」を procedure の所属
 * feature へ畳み、`usedBy` として与える（`mapInventoryToConcepts` はそこから概念を辿る）。
 *
 * PageProcedures を構造的に受け取り call-graph.ts へは依存しない（この層は型チェッカーを
 * 持ち込まずに単体で試せることを保つ）。
 */
export function attributeRoutesByCallGraph(
  items: readonly InventoryItem[],
  pages: readonly { route: string; procedures: readonly string[] }[],
): InventoryItem[] {
  const featureOfProcedure = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'trpc-procedure' && item.feature !== undefined) {
      featureOfProcedure.set(item.id, item.feature);
    }
  }
  const featuresOfRoute = new Map<string, string[]>();
  for (const page of pages) {
    const features = new Set<string>();
    for (const procedure of page.procedures) {
      const feature = featureOfProcedure.get(procedure);
      if (feature !== undefined) features.add(feature);
    }
    if (features.size > 0) featuresOfRoute.set(page.route, [...features].sort());
  }

  return items.map((item) => {
    if (item.kind !== 'route') return item;
    const features = featuresOfRoute.get(item.id);
    if (features === undefined) return item;
    const usedBy = [...new Set([...(item.usedBy ?? []), ...features])].sort();
    return { ...item, usedBy, detail: `uses ${usedBy.join(', ')}` };
  });
}

export interface KindSummary {
  kind: InventoryKind;
  total: number;
  direct: number;
  viaFeature: number;
  unmapped: number;
  /** 未マッピングのうち、語彙を持たないことが正しいもの */
  outOfScope: number;
}

export function summarizeByKind(map: ConceptMap): KindSummary[] {
  return INVENTORY_KINDS.map((kind) => {
    const items = map.items.filter((item) => item.kind === kind);
    const direct = items.filter((item) => item.links.some((link) => link.via === 'direct'));
    const viaOnly = items.filter(
      (item) => item.links.length > 0 && !item.links.some((link) => link.via === 'direct'),
    );
    const unmapped = items.filter((item) => item.links.length === 0);
    const outOfScope = unmapped.filter((item) => vocabularyExclusionReason(item) !== undefined);
    return {
      kind,
      total: items.length,
      direct: direct.length,
      viaFeature: viaOnly.length,
      unmapped: unmapped.length - outOfScope.length,
      outOfScope: outOfScope.length,
    };
  }).filter((summary) => summary.total > 0);
}

function code(text: string): string {
  return `\`${text}\``;
}

function mermaidId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function isDirectFor(item: MappedItem, conceptId: string): boolean {
  return item.links.some((link) => link.conceptId === conceptId && link.via === 'direct');
}

/** 概念 1 つを中心に、直接対応する item だけを描く（feature 経由の大量 item は表で見る）。 */
export function renderConceptDiagram(entry: GlossaryEntry, items: MappedItem[]): string {
  const direct = items.filter((item) => isDirectFor(item, entry.id));
  const lines = ['graph LR', `  concept(["${entry.concept}<br/>${entry.id}"])`];
  for (const item of direct) {
    const id = mermaidId(item.kind.replace(/-/g, '_'), item.id);
    lines.push(`  ${id}["${INVENTORY_KIND_LABELS[item.kind]}<br/>${item.id}"]`);
    lines.push(`  concept --> ${id}`);
  }
  return lines.join('\n');
}

export function renderInventoryDocument(
  map: ConceptMap,
  glossary: readonly GlossaryEntry[],
  header: string,
): string {
  const out: string[] = [];
  out.push('# Architecture Inventory（自動生成）', '', header, '');
  out.push(
    '実装から自動発見した項目（事実）と、用語集（`scripts/lib/glossary/terms.ts`）が与える意味の対応。',
    'どの概念からも辿れない項目は 2 つに分かれる。**概念を足す候補**（用語集へ 1 行足すか実装を消すかを人間が判断する）と、',
    '**語彙を持たない層**（SQL 内部・認証の定型画面・共通 UI など、概念が付かないことが正しいもの）。',
    '',
  );

  out.push('## 概要', '');
  out.push('| 種別 | 件数 | 概念へ直接 | feature 経由のみ | 語彙を持たない層 | 概念を足す候補 |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const summary of summarizeByKind(map)) {
    out.push(
      `| ${INVENTORY_KIND_LABELS[summary.kind]} | ${summary.total} | ${summary.direct} | ${summary.viaFeature} | ${summary.outOfScope} | ${summary.unmapped} |`,
    );
  }
  out.push('');

  out.push('## 概念 → 実装', '');
  out.push('用語集の順。直接対応する項目を図に、feature 経由を含む全項目を表に出す。', '');
  for (const entry of glossary) {
    const items = map.byConcept.get(entry.id) ?? [];
    if (items.length === 0) continue;
    const direct = items.filter((item) => isDirectFor(item, entry.id));
    out.push(`### ${entry.concept}（${code(entry.id)}）`, '');
    out.push(entry.usage, '');
    if (direct.length > 0) {
      out.push('```mermaid', renderConceptDiagram(entry, items), '```', '');
    }
    out.push('| 種別 | 項目 | 経路 |', '| --- | --- | --- |');
    for (const kind of INVENTORY_KINDS) {
      const ofKind = items.filter((item) => item.kind === kind);
      if (ofKind.length === 0) continue;
      const directRows = ofKind.filter((item) => isDirectFor(item, entry.id));
      const viaRows = ofKind.filter((item) => !isDirectFor(item, entry.id));
      for (const [rows, label] of [
        [directRows, '直接'],
        [viaRows, 'feature 経由'],
      ] as const) {
        if (rows.length === 0) continue;
        out.push(
          `| ${INVENTORY_KIND_LABELS[kind]} | ${rows.map((item) => code(item.id)).join(', ')} | ${label} |`,
        );
      }
    }
    out.push('');
  }

  const unmapped = map.items.filter((item) => item.links.length === 0);
  const candidates = unmapped.filter((item) => vocabularyExclusionReason(item) === undefined);
  const outOfScope = unmapped.filter((item) => vocabularyExclusionReason(item) !== undefined);

  out.push('## 概念を足す候補', '');
  out.push(
    'どの概念からも辿れず、かつ「語彙を持たない層」にも当たらない項目。',
    '用語集へ 1 行足すか、実装を消すかを人間が判断する。',
    '',
  );
  if (candidates.length === 0) {
    out.push('なし。', '');
  } else {
    out.push('| 種別 | 項目 | 発見元 | 補足 |', '| --- | --- | --- | --- |');
    for (const item of candidates) {
      out.push(
        `| ${INVENTORY_KIND_LABELS[item.kind]} | ${code(item.id)} | ${code(item.path)} | ${item.detail ?? '—'} |`,
      );
    }
    out.push('');
  }

  out.push('## 語彙を持たない層（意図的）', '');
  out.push(
    '概念が付かないことが正しい項目。判定規則は `scripts/lib/architecture-map/vocabulary-scope.ts` が持つ。',
    'ここに落ちるのが誤りだと思ったら、規則の方を直す（表を手で編集しない）。',
    '',
  );
  if (outOfScope.length === 0) {
    out.push('なし。', '');
  } else {
    const byReason = new Map<string, MappedItem[]>();
    for (const item of outOfScope) {
      const reason = vocabularyExclusionReason(item) ?? '';
      byReason.set(reason, [...(byReason.get(reason) ?? []), item]);
    }
    out.push('| 理由 | 種別 | 件数 | 項目 |', '| --- | --- | --- | --- |');
    for (const [reason, rows] of byReason) {
      for (const kind of INVENTORY_KINDS) {
        const ofKind = rows.filter((item) => item.kind === kind);
        if (ofKind.length === 0) continue;
        out.push(
          `| ${reason} | ${INVENTORY_KIND_LABELS[kind]} | ${ofKind.length} | ${ofKind.map((item) => code(item.id)).join(', ')} |`,
        );
      }
    }
    out.push('');
  }

  return out.join('\n');
}
