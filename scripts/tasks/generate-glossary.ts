#!/usr/bin/env node

/**
 * glossary:generate — docs/product/glossary.md の用語表を生成する
 *
 * 正本は `scripts/lib/glossary/terms.ts`。このスクリプトは生成マーカーの間だけを
 * 差し替える（前文と詳細ノートは手書きのまま残す）。
 *
 * `generate-rls-snapshot.ts` と同型:
 *   - レジストリが不整合なら生成しない（fail closed、exit 2）
 *   - lint-staged と同じ prettier を通してから書く（--check の偽 drift を防ぐ）
 *   - --check は差分があれば exit 1
 *
 * Usage:
 *   pnpm glossary:generate
 *   pnpm glossary:check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier } from 'prettier';

import {
  renderGeneratedSections,
  replaceGeneratedBlock,
  validateRegistry,
} from '../lib/glossary/core.ts';
import { GLOSSARY, KEY_NAME_RULES } from '../lib/glossary/terms.ts';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUTPUT_PATH = resolve(ROOT, 'docs/product/glossary.md');

const CHECK_MODE = process.argv.includes('--check');

export async function buildGlossaryMarkdown(): Promise<string> {
  const problems = validateRegistry(GLOSSARY, KEY_NAME_RULES);
  if (problems.length > 0) {
    throw new Error(`用語集レジストリが不整合です:\n  - ${problems.join('\n  - ')}`);
  }

  const existing = readFileSync(OUTPUT_PATH, 'utf8');
  const replaced = replaceGeneratedBlock(
    existing,
    renderGeneratedSections(GLOSSARY, KEY_NAME_RULES),
  );

  return formatWithPrettier(replaced, { parser: 'markdown', printWidth: 100 });
}

async function main(): Promise<void> {
  let content: string;
  try {
    content = await buildGlossaryMarkdown();
  } catch (error) {
    console.error('❌ 用語集の生成に失敗しました。');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  if (CHECK_MODE) {
    const existing = readFileSync(OUTPUT_PATH, 'utf8');
    if (existing.trim() !== content.trim()) {
      console.error('❌ docs/product/glossary.md が最新ではありません。');
      console.error('   pnpm glossary:generate を実行して更新してください。');
      process.exit(1);
    }
    console.log('✅ docs/product/glossary.md は最新です。');
    return;
  }

  writeFileSync(OUTPUT_PATH, content);
  console.log(`✅ 用語集を生成しました: ${OUTPUT_PATH}`);
}

// docs-guard の glossary-sync checker が buildGlossaryMarkdown() を import するため、
// import されただけの時は main を走らせない。
if (isDirectExecution(import.meta.url)) {
  void main();
}
