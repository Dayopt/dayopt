#!/usr/bin/env node

/**
 * architecture:generate / architecture:check — text 正本から Architecture Map の view を生成する
 *
 * 正本（text）と生成先:
 *   - `apps/product/src/lib/database/generated/database.types.ts`（CI が migration との一致を検査済み）
 *       → `docs/engineering/architecture.md` の生成ブロック（テーブル一覧 + ER 図 2 枚）
 *   - `docs/engineering/invariants.md` §時刻 の写し表
 *       → 同 doc 直下の生成ブロック（時刻規則の流れ図）
 *   - `scripts/lib/glossary/terms.ts` の `db:`
 *       → ER 図「概念に紐づくテーブル」の選択に使う
 *   - `apps/product/eslint.config.mjs` の no-restricted-imports + features/ の実 import
 *       → architecture.md の生成ブロック（Feature DAG 図）
 *   - 実装の自動発見（feature / table / 関数 / router / procedure / MCP tool / store / Story / route / i18n）
 *     + 用語集の対応（`code.feature` / `db` / `mcpTools` / `i18nNamespace`）
 *       → `docs/engineering/data/architecture-inventory.md`（全文生成。未マッピングも一覧）
 *       → `docs/engineering/data/architecture/{model,views}.c4`（LikeC4 の探索 view）
 *
 * あわせて、text 正本が指す参照（feature / 識別子 / DB / path / symbol）の実在を検査する。
 *
 * `generate-glossary.ts` と同型:
 *   - 正本が読めなければ生成しない（fail closed、exit 2）
 *   - prettier を通してから書く（--check の偽 drift を防ぐ）
 *   - --check は差分または参照切れがあれば exit 1
 *
 * Usage:
 *   pnpm architecture:generate
 *   pnpm architecture:check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

import { buildCallGraph, type CallGraph } from '../lib/architecture-map/call-graph.ts';
import {
  mapInventoryToConcepts,
  renderInventoryDocument,
} from '../lib/architecture-map/concept-map.ts';
import { renderErDiagram, renderTableIndex } from '../lib/architecture-map/er-diagram.ts';
import {
  buildFeatureDag,
  checkFeatureDagConsistency,
  collectFeatureDependencies,
  parseFeatureRules,
  renderFeatureDagDiagram,
  type FeatureDag,
} from '../lib/architecture-map/feature-dag.ts';
import {
  architectureMapMarkers,
  replaceGeneratedBlock,
} from '../lib/architecture-map/generated-block.ts';
import {
  discoverInventory,
  discoverTrpcRouters,
  resolveRouterNamespaces,
  type InventoryItem,
} from '../lib/architecture-map/inventory.ts';
import { renderLikeC4Model, renderLikeC4Views } from '../lib/architecture-map/likec4-model.ts';
import {
  checkGlossaryReferences,
  checkTimeRuleMirrorReferences,
  collectProductSources,
  type ReferenceViolation,
} from '../lib/architecture-map/references.ts';
import { collectMcpToolProcedures, collectRelations } from '../lib/architecture-map/relations.ts';
import { parseSchemaModel, type SchemaModel } from '../lib/architecture-map/schema-model.ts';
import { renderSurfaceDocument } from '../lib/architecture-map/surface-document.ts';
import { discoverSystemSurface, type SystemSurface } from '../lib/architecture-map/surface.ts';
import {
  parseTimeRulesSection,
  renderTimeRulesDiagram,
} from '../lib/architecture-map/time-rules.ts';
import { GLOSSARY } from '../lib/glossary/terms.ts';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const SCHEMA_TYPES_PATH = 'apps/product/src/lib/database/generated/database.types.ts';
const ESLINT_CONFIG_PATH = 'apps/product/eslint.config.mjs';
const ARCHITECTURE_DOC = 'docs/engineering/architecture.md';
const INVARIANTS_DOC = 'docs/engineering/invariants.md';
export const INVENTORY_DOC = 'docs/engineering/data/architecture-inventory.md';
export const SURFACE_DOC = 'docs/engineering/data/system-surface.md';
const LIKEC4_DIR = 'docs/engineering/data/architecture';
export const LIKEC4_MODEL = `${LIKEC4_DIR}/model.c4`;
export const LIKEC4_VIEWS = `${LIKEC4_DIR}/views.c4`;

const ER_MARKERS = architectureMapMarkers('er', SCHEMA_TYPES_PATH);
const FEATURE_DAG_MARKERS = architectureMapMarkers(
  'feature-dag',
  `${ESLINT_CONFIG_PATH} の no-restricted-imports と features/ の実 import`,
);
const TIME_RULES_MARKERS = architectureMapMarkers(
  'time-rules',
  '直上の「規則の写しと、その分類」表',
);

const CHECK_MODE = process.argv.includes('--check');

export interface GeneratedDocument {
  /** repo-relative path */
  path: string;
  content: string;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** 全文生成の doc は初回に存在しないので、無ければ空文字として drift 扱いにする */
function readRepoFileOrEmpty(path: string): string {
  return existsSync(resolve(ROOT, path)) ? readRepoFile(path) : '';
}

export function loadFeatureDag(): FeatureDag {
  return buildFeatureDag(
    parseFeatureRules(readRepoFile(ESLINT_CONFIG_PATH)),
    collectFeatureDependencies(collectProductSources(ROOT)),
  );
}

/** 型チェッカーで呼び出し経路を辿る（entry point は inventory が見つけた router / tool / page）。 */
export function buildProductCallGraph(
  items: InventoryItem[],
  sources: ReturnType<typeof collectProductSources>,
  schema: SchemaModel,
  mcpToolFiles: Map<string, string>,
): CallGraph {
  const appRouter = sources.find(
    (file) => file.path === 'apps/product/src/app/api/trpc/_server/app-router.ts',
  );
  if (appRouter === undefined) throw new Error('app-router.ts が見つかりません');

  const pageFiles = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'route') pageFiles.set(item.id, item.path);
  }

  return buildCallGraph({
    root: ROOT,
    namespaceOfPath: resolveRouterNamespaces(sources, discoverTrpcRouters(appRouter)),
    tableNames: new Set(schema.tables.map((table) => table.name)),
    functionNames: new Set(schema.functions),
    procedureIds: new Set(
      items.filter((item) => item.kind === 'trpc-procedure').map((item) => item.id),
    ),
    mcpToolFiles,
    pageFiles,
  });
}

export function loadSchemaModel(): SchemaModel {
  return parseSchemaModel(readRepoFile(SCHEMA_TYPES_PATH));
}

/** 用語集の `db:` が指すテーブル名（列指定は table 部分だけ、関数は除く）。 */
export function conceptLinkedTables(schema: SchemaModel): string[] {
  const names = new Set<string>();
  for (const entry of GLOSSARY) {
    for (const ref of entry.db ?? []) {
      const table = ref.split('.')[0];
      if (schema.tables.some((candidate) => candidate.name === table)) names.add(table);
    }
  }
  return [...names].sort();
}

function renderErBlock(schema: SchemaModel): string {
  const concept = conceptLinkedTables(schema);
  return [
    `### テーブル一覧（public、${schema.tables.length} テーブル）`,
    '',
    renderTableIndex(schema),
    '',
    '### ER 図: 概念に紐づくテーブル',
    '',
    `用語集（\`docs/product/glossary.md\`）の DB 列が指すテーブルだけを描く。部分集合の外へ向かう FK は全体図で見る。`,
    '',
    '```mermaid',
    renderErDiagram(schema, concept),
    '```',
    '',
    '### ER 図: 全テーブル',
    '',
    '```mermaid',
    renderErDiagram(schema),
    '```',
  ].join('\n');
}

function renderFeatureDagBlock(dag: FeatureDag): string {
  return [
    '実際の runtime import（stories / test を除く）を描く。層は依存の最長経路、種別（Layer 0 / independent / composition）は ESLint の規則から取る。',
    '',
    '```mermaid',
    renderFeatureDagDiagram(dag),
    '```',
  ].join('\n');
}

export async function buildArchitectureMapDocs(): Promise<GeneratedDocument[]> {
  const schema = loadSchemaModel();
  const architecture = replaceGeneratedBlock(
    replaceGeneratedBlock(
      readRepoFile(ARCHITECTURE_DOC),
      FEATURE_DAG_MARKERS,
      renderFeatureDagBlock(loadFeatureDag()),
      ARCHITECTURE_DOC,
    ),
    ER_MARKERS,
    renderErBlock(schema),
    ARCHITECTURE_DOC,
  );

  const invariantsSource = readRepoFile(INVARIANTS_DOC);
  const timeRules = parseTimeRulesSection(invariantsSource);
  const invariants = replaceGeneratedBlock(
    invariantsSource,
    TIME_RULES_MARKERS,
    ['```mermaid', renderTimeRulesDiagram(timeRules), '```'].join('\n'),
    INVARIANTS_DOC,
  );

  const sources = collectProductSources(ROOT);
  const items = discoverInventory(ROOT, sources, schema);
  const conceptMap = mapInventoryToConcepts(items, GLOSSARY);
  const systemSurface = discoverSystemSurface(
    ROOT,
    sources,
    items.filter((item) => item.kind === 'mcp-tool'),
  );
  const relations = collectRelations(ROOT, sources, items);
  const callGraph = buildProductCallGraph(items, sources, schema, relations.mcpToolFiles);
  const likec4Sources = {
    callGraph,
    map: conceptMap,
    glossary: GLOSSARY,
    dag: buildFeatureDag(
      parseFeatureRules(readRepoFile(ESLINT_CONFIG_PATH)),
      collectFeatureDependencies(sources),
    ),
    schema,
    surface: systemSurface,
    relations,
  };
  const inventory = renderInventoryDocument(
    conceptMap,
    GLOSSARY,
    [
      '> **生成元**: `scripts/tasks/generate-architecture-map.ts`（`pnpm architecture:generate`）。',
      '> 実装（`apps/product/src` / `supabase`）から自動発見した項目に、`scripts/lib/glossary/terms.ts` の対応を重ねた snapshot。',
      '> **手で編集しない**。drift は `pnpm architecture:check`（docs-guard からも常時実行）が検出する。',
    ].join('\n'),
  );

  const surface = renderSurfaceDocument(
    systemSurface,
    relations,
    items,
    callGraph,
    [
      '> **生成元**: `scripts/tasks/generate-architecture-map.ts`（`pnpm architecture:generate`）。',
      '> 実装（`apps/*` / `supabase` / `.github` / `scripts`）から自動発見した運用面の snapshot。',
      '> **手で編集しない**。drift は `pnpm architecture:check`（docs-guard からも常時実行）が検出する。',
    ].join('\n'),
  );

  const documents: GeneratedDocument[] = [];
  for (const [path, content] of [
    [ARCHITECTURE_DOC, architecture],
    [INVARIANTS_DOC, invariants],
    [INVENTORY_DOC, inventory],
    [SURFACE_DOC, surface],
    [LIKEC4_MODEL, renderLikeC4Model(likec4Sources)],
    [LIKEC4_VIEWS, renderLikeC4Views(likec4Sources)],
  ] as const) {
    if (!path.endsWith('.md')) {
      documents.push({ path, content });
      continue;
    }
    // repo の .prettierrc（singleQuote 等）を解決してから整形する。既定設定で整形すると
    // doc 内の埋め込み code block が別 style になり、format:check で偽 drift が出る
    const filepath = resolve(ROOT, path);
    const config = (await resolvePrettierConfig(filepath)) ?? {};
    documents.push({
      path,
      content: await formatWithPrettier(content, { ...config, parser: 'markdown', filepath }),
    });
  }
  return documents;
}

/**
 * 自動発見した面どうしの整合を検査する。
 *
 *   - 分析イベントが TS と DB の CHECK 制約で食い違っていないか（片方だけ足すと insert が落ちる）
 *   - app が参照する DT コードを migration が実際に raise するか
 *   - MCP tool が呼ぶ tRPC procedure が実在するか
 */
export function checkSurfaceConsistency(
  surface: SystemSurface,
  items: InventoryItem[],
  sources: ReturnType<typeof collectProductSources>,
  callGraph: CallGraph,
): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];

  // MCP の書き込み tool は receipt を残す apply_mcp_* を必ず通る（直接 table を書かない）
  for (const tool of callGraph.mcpTools) {
    const isWrite = /\.(create|update|delete|restore)$/.test(tool.tool);
    if (!isWrite) continue;
    if (!tool.functions.some((fn) => fn.startsWith('apply_mcp_'))) {
      violations.push({
        source: 'mcp-tool',
        reason: `書き込み tool '${tool.tool}' が apply_mcp_* を通らずに DB へ到達しています`,
      });
    }
  }

  for (const event of surface.analyticsEvents) {
    if (!event.allowedInDb) {
      violations.push({
        source: 'analytics-event',
        reason: `'${event.id}' は PRODUCT_EVENT_NAMES にあるが product_events の CHECK 制約が許可していません`,
      });
    }
  }

  for (const entry of surface.errorCodes) {
    if (entry.raisedIn === 0 && entry.referencedIn.length > 0) {
      violations.push({
        source: 'db-error-code',
        reason: `${entry.code} を app が参照しているが、migration のどこからも RAISE されていません（${entry.referencedIn[0]}）`,
      });
    }
  }

  const procedures = new Set(
    items.filter((item) => item.kind === 'trpc-procedure').map((item) => item.id),
  );
  for (const tool of collectMcpToolProcedures(sources)) {
    for (const procedure of tool.procedures) {
      if (!procedures.has(procedure)) {
        violations.push({
          source: 'mcp-tool',
          reason: `${tool.path} が呼ぶ '${procedure}' は tRPC に存在しません`,
        });
      }
    }
  }

  return violations;
}

export function checkArchitectureReferences(): ReferenceViolation[] {
  const schema = loadSchemaModel();
  const sources = collectProductSources(ROOT);
  const timeRules = parseTimeRulesSection(readRepoFile(INVARIANTS_DOC));
  const dag = buildFeatureDag(
    parseFeatureRules(readRepoFile(ESLINT_CONFIG_PATH)),
    collectFeatureDependencies(sources),
  );
  const items = discoverInventory(ROOT, sources, schema);
  const mcpTools = new Set(items.filter((item) => item.kind === 'mcp-tool').map((item) => item.id));
  const mcpViolations: ReferenceViolation[] = [];
  for (const entry of GLOSSARY) {
    for (const tool of entry.mcpTools ?? []) {
      if (!mcpTools.has(tool)) {
        mcpViolations.push({
          source: `glossary:${entry.id}`,
          reason: `mcpTools '${tool}' は MCP registry にありません`,
        });
      }
    }
  }
  return [
    ...mcpViolations,
    ...checkSurfaceConsistency(
      discoverSystemSurface(
        ROOT,
        sources,
        items.filter((item) => item.kind === 'mcp-tool'),
      ),
      items,
      sources,
      buildProductCallGraph(
        items,
        sources,
        schema,
        collectRelations(ROOT, sources, items).mcpToolFiles,
      ),
    ),
    ...checkGlossaryReferences(GLOSSARY, schema, sources, ROOT),
    ...checkTimeRuleMirrorReferences(timeRules.mirrors, sources),
    ...checkFeatureDagConsistency(dag).map((reason) => ({ source: 'feature-dag', reason })),
  ];
}

/** 生成物が最新でない doc の path を返す（空なら最新）。 */
export async function findStaleArchitectureMapDocs(): Promise<string[]> {
  const documents = await buildArchitectureMapDocs();
  return documents
    .filter((document) => readRepoFileOrEmpty(document.path).trim() !== document.content.trim())
    .map((document) => document.path);
}

async function main(): Promise<void> {
  let documents: GeneratedDocument[];
  let violations: ReferenceViolation[];
  try {
    documents = await buildArchitectureMapDocs();
    violations = checkArchitectureReferences();
  } catch (error) {
    console.error('❌ Architecture Map の生成に失敗しました。');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  let ok = true;
  if (violations.length > 0) {
    ok = false;
    console.error(`❌ 参照切れ ${violations.length} 件:`);
    for (const violation of violations)
      console.error(`   ${violation.source}: ${violation.reason}`);
  } else {
    console.log('✅ text 正本の参照は全件実在します。');
  }

  if (CHECK_MODE) {
    for (const document of documents) {
      if (readRepoFileOrEmpty(document.path).trim() !== document.content.trim()) {
        ok = false;
        console.error(`❌ ${document.path} の生成ブロックが最新ではありません。`);
      }
    }
    if (ok) console.log('✅ Architecture Map の生成ブロックは最新です。');
    else console.error('   pnpm architecture:generate を実行して更新してください。');
    process.exit(ok ? 0 : 1);
  }

  for (const document of documents) {
    mkdirSync(dirname(resolve(ROOT, document.path)), { recursive: true });
    writeFileSync(resolve(ROOT, document.path), document.content);
    console.log(`✅ 生成しました: ${document.path}`);
  }
  if (!ok) process.exit(1);
}

// docs-guard の checker が build / check 関数を import するため、import 時は main を走らせない。
if (isDirectExecution(import.meta.url)) {
  void main();
}
