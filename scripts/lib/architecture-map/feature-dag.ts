/**
 * feature 間の依存（Feature DAG）を 2 つの text 正本から読む。
 *
 *   - 許可される依存: `apps/product/eslint.config.mjs` の `no-restricted-imports`
 *     （`pnpm lint` が hard 強制。ここが規則の正本）
 *   - 実際の依存: `apps/product/src/features/<f>/` の `@/features/<g>` import
 *     （stories / test を除く runtime の import）
 *
 * 図は「実際の依存」を描き、層（Layer）は実際の依存の最長経路で決める。規則が与える
 * 種別（Layer 0 / independent / composition）は config から取る。実際の依存が規則の
 * 許可外なら不整合として返す（lint が止めるはずのものが図に紛れないための guard）。
 */

import ts from 'typescript';

import type { SourceFile } from './references.ts';

export type FeatureKind = 'layer0' | 'independent' | 'composition' | 'layered';

export interface FeatureRule {
  feature: string;
  /** `@/features/*` を丸ごと禁止（他 feature へ依存しない） */
  bansAllFeatures: boolean;
  /** 全 feature の deep import だけを禁止（barrel は許可 = composition） */
  deepImportOnlyBan: boolean;
  /** `@/features/<x>` を丸ごと禁止された feature 名 */
  bannedFeatures: string[];
}

export interface FeatureDependency {
  from: string;
  to: string;
}

export interface FeatureDag {
  features: string[];
  rules: Map<string, FeatureRule>;
  edges: FeatureDependency[];
  kinds: Map<string, FeatureKind>;
  layers: Map<string, number>;
}

const FEATURE_FILES = /^src\/features\/([a-z-]+)\/\*\*/;
const FEATURE_GROUP = /^@\/features\/([a-z-]+)(\/\*\*)?$/;

function stringElements(node: ts.Node | undefined): string[] {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.filter(ts.isStringLiteral).map((element) => element.text);
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = member.name;
    const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (keyText === name) return member.initializer;
  }
  return undefined;
}

/** `no-restricted-imports` の patterns[].group を平坦化して返す。 */
function restrictedGroups(rules: ts.Expression | undefined): string[] {
  if (rules === undefined || !ts.isObjectLiteralExpression(rules)) return [];
  const rule = property(rules, 'no-restricted-imports');
  if (rule === undefined || !ts.isArrayLiteralExpression(rule)) return [];
  const groups: string[] = [];
  for (const element of rule.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const patterns = property(element, 'patterns');
    if (patterns === undefined || !ts.isArrayLiteralExpression(patterns)) continue;
    for (const pattern of patterns.elements) {
      if (!ts.isObjectLiteralExpression(pattern)) continue;
      groups.push(...stringElements(property(pattern, 'group')));
    }
  }
  return groups;
}

/** eslint.config.mjs のソースから feature ごとの規則を取り出す。 */
export function parseFeatureRules(source: string): Map<string, FeatureRule> {
  const sourceFile = ts.createSourceFile(
    'eslint.config.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const rules = new Map<string, FeatureRule>();

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const features = stringElements(property(node, 'files'))
        .map((pattern) => pattern.match(FEATURE_FILES)?.[1])
        .filter((name): name is string => name !== undefined);
      if (features.length > 0) {
        const groups = restrictedGroups(property(node, 'rules'));
        const banned = new Set<string>();
        let bansAllFeatures = false;
        let deepImportOnlyBan = false;
        for (const group of groups) {
          if (group === '@/features/*' || group === '@/features/**') bansAllFeatures = true;
          else if (group === '@/features/*/**') deepImportOnlyBan = true;
          else {
            const match = group.match(FEATURE_GROUP);
            if (match && match[2] === undefined) banned.add(match[1]);
          }
        }
        for (const feature of features) {
          rules.set(feature, {
            feature,
            bansAllFeatures,
            deepImportOnlyBan,
            bannedFeatures: [...banned].sort(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (rules.size === 0) {
    throw new Error(
      'eslint.config.mjs から feature の no-restricted-imports 規則を 1 つも取り出せませんでした',
    );
  }
  return rules;
}

const IMPORT_RE = /(?<![.\w])(?:from|import)\s*\(?\s*['"]@\/features\/([a-z-]+)/g;

/** features/<f>/ の runtime import（stories / test を除く）から実際の依存 edge を取り出す。 */
export function collectFeatureDependencies(sources: SourceFile[]): FeatureDependency[] {
  const edges = new Set<string>();
  for (const file of sources) {
    const owner = file.path.match(/^apps\/product\/src\/features\/([a-z-]+)\//)?.[1];
    if (owner === undefined) continue;
    if (/\.(stories|test)\.tsx?$/.test(file.path)) continue;
    for (const match of file.text.matchAll(IMPORT_RE)) {
      if (match[1] !== owner) edges.add(`${owner}>${match[1]}`);
    }
  }
  return [...edges].sort().map((edge) => {
    const [from, to] = edge.split('>');
    return { from, to };
  });
}

export function buildFeatureDag(
  rules: Map<string, FeatureRule>,
  edges: FeatureDependency[],
): FeatureDag {
  const features = [...new Set([...rules.keys(), ...edges.flatMap((e) => [e.from, e.to])])].sort();
  const importers = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();
  for (const feature of features) {
    importers.set(feature, new Set());
    dependencies.set(feature, new Set());
  }
  for (const edge of edges) {
    importers.get(edge.to)?.add(edge.from);
    dependencies.get(edge.from)?.add(edge.to);
  }

  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (feature: string): number => {
    const known = layers.get(feature);
    if (known !== undefined) return known;
    if (visiting.has(feature)) {
      throw new Error(`feature 依存に循環があります: ${feature}`);
    }
    visiting.add(feature);
    let layer = 0;
    for (const dependency of dependencies.get(feature) ?? []) {
      layer = Math.max(layer, layerOf(dependency) + 1);
    }
    visiting.delete(feature);
    layers.set(feature, layer);
    return layer;
  };
  for (const feature of features) layerOf(feature);

  const kinds = new Map<string, FeatureKind>();
  for (const feature of features) {
    const rule = rules.get(feature);
    if (rule?.deepImportOnlyBan && !rule.bansAllFeatures && rule.bannedFeatures.length === 0) {
      kinds.set(feature, 'composition');
    } else if (rule?.bansAllFeatures) {
      kinds.set(feature, (importers.get(feature)?.size ?? 0) > 0 ? 'layer0' : 'independent');
    } else {
      kinds.set(feature, 'layered');
    }
  }

  return { features, rules, edges, kinds, layers };
}

/** 実際の依存が config の許可外なら理由を返す（空なら整合）。 */
export function checkFeatureDagConsistency(dag: FeatureDag): string[] {
  const problems: string[] = [];
  for (const edge of dag.edges) {
    const rule = dag.rules.get(edge.from);
    if (rule === undefined) {
      problems.push(
        `${edge.from} に eslint の feature 規則がありません（→ ${edge.to} を import している）`,
      );
    } else if (rule.bansAllFeatures) {
      problems.push(`${edge.from} は他 feature への依存が禁止だが ${edge.to} を import している`);
    } else if (rule.bannedFeatures.includes(edge.to)) {
      problems.push(`${edge.from} → ${edge.to} は eslint で禁止されている`);
    }
  }
  return problems;
}

function nodeLabel(dag: FeatureDag, feature: string): string {
  const kind = dag.kinds.get(feature);
  if (kind === 'composition') return `${feature} (composition)`;
  if (kind === 'independent') return `${feature} (independent)`;
  return `${feature} (Layer ${dag.layers.get(feature) ?? 0})`;
}

/** Feature DAG を Mermaid で描く。層ごとに subgraph、composition と independent は別枠。 */
export function renderFeatureDagDiagram(dag: FeatureDag): string {
  const lines: string[] = ['graph TD'];
  const ids = new Map(dag.features.map((feature) => [feature, feature.replace(/-/g, '_')]));

  const layered = dag.features.filter((f) =>
    ['layer0', 'layered'].includes(dag.kinds.get(f) ?? ''),
  );
  const maxLayer = Math.max(0, ...layered.map((f) => dag.layers.get(f) ?? 0));
  for (let layer = 0; layer <= maxLayer; layer++) {
    const members = layered.filter((f) => dag.layers.get(f) === layer);
    if (members.length === 0) continue;
    lines.push(`  subgraph L${layer}["Layer ${layer}"]`);
    for (const feature of members)
      lines.push(`    ${ids.get(feature)}["${nodeLabel(dag, feature)}"]`);
    lines.push('  end');
  }
  for (const [kind, title] of [
    ['composition', 'Composition'],
    ['independent', 'Independent'],
  ] as const) {
    const members = dag.features.filter((f) => dag.kinds.get(f) === kind);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${title}`);
    for (const feature of members)
      lines.push(`    ${ids.get(feature)}["${nodeLabel(dag, feature)}"]`);
    lines.push('  end');
  }
  for (const edge of dag.edges) {
    lines.push(`  ${ids.get(edge.from)} --> ${ids.get(edge.to)}`);
  }
  return lines.join('\n');
}
