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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

import { renderErDiagram, renderTableIndex } from '../lib/architecture-map/er-diagram.ts';
import {
  architectureMapMarkers,
  replaceGeneratedBlock,
} from '../lib/architecture-map/generated-block.ts';
import {
  checkGlossaryReferences,
  checkTimeRuleMirrorReferences,
  collectProductSources,
  type ReferenceViolation,
} from '../lib/architecture-map/references.ts';
import { parseSchemaModel, type SchemaModel } from '../lib/architecture-map/schema-model.ts';
import {
  parseTimeRulesSection,
  renderTimeRulesDiagram,
} from '../lib/architecture-map/time-rules.ts';
import { GLOSSARY } from '../lib/glossary/terms.ts';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const SCHEMA_TYPES_PATH = 'apps/product/src/lib/database/generated/database.types.ts';
const ARCHITECTURE_DOC = 'docs/engineering/architecture.md';
const INVARIANTS_DOC = 'docs/engineering/invariants.md';

const ER_MARKERS = architectureMapMarkers('er', SCHEMA_TYPES_PATH);
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

export async function buildArchitectureMapDocs(): Promise<GeneratedDocument[]> {
  const schema = loadSchemaModel();
  const architecture = replaceGeneratedBlock(
    readRepoFile(ARCHITECTURE_DOC),
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

  const documents: GeneratedDocument[] = [];
  for (const [path, content] of [
    [ARCHITECTURE_DOC, architecture],
    [INVARIANTS_DOC, invariants],
  ] as const) {
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

export function checkArchitectureReferences(): ReferenceViolation[] {
  const schema = loadSchemaModel();
  const sources = collectProductSources(ROOT);
  const timeRules = parseTimeRulesSection(readRepoFile(INVARIANTS_DOC));
  return [
    ...checkGlossaryReferences(GLOSSARY, schema, sources, ROOT),
    ...checkTimeRuleMirrorReferences(timeRules.mirrors, sources),
  ];
}

/** 生成物が最新でない doc の path を返す（空なら最新）。 */
export async function findStaleArchitectureMapDocs(): Promise<string[]> {
  const documents = await buildArchitectureMapDocs();
  return documents
    .filter((document) => readRepoFile(document.path).trim() !== document.content.trim())
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
      if (readRepoFile(document.path).trim() !== document.content.trim()) {
        ok = false;
        console.error(`❌ ${document.path} の生成ブロックが最新ではありません。`);
      }
    }
    if (ok) console.log('✅ Architecture Map の生成ブロックは最新です。');
    else console.error('   pnpm architecture:generate を実行して更新してください。');
    process.exit(ok ? 0 : 1);
  }

  for (const document of documents) {
    writeFileSync(resolve(ROOT, document.path), document.content);
    console.log(`✅ 生成しました: ${document.path}`);
  }
  if (!ok) process.exit(1);
}

// docs-guard の checker が build / check 関数を import するため、import 時は main を走らせない。
if (isDirectExecution(import.meta.url)) {
  void main();
}
