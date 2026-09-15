/**
 * text 正本が指す参照（feature dir / 識別子 / DB テーブル・列・関数 / path / symbol）が
 * repo に実在するかを検査する。
 *
 * 対象:
 *   - `scripts/lib/glossary/terms.ts` の `code.feature` / `code.identifiers` / `db`
 *   - `docs/engineering/invariants.md` §時刻 写し表の path と symbol
 *
 * rename / delete で索引が黙って古くなる class をここで閉じる。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { GlossaryEntry } from '../glossary/core.ts';
import { findTable, type SchemaModel } from './schema-model.ts';
import type { TimeRuleMirror } from './time-rules.ts';

export interface ReferenceViolation {
  source: string;
  reason: string;
}

export interface SourceFile {
  /** repo-relative path */
  path: string;
  text: string;
}

const PRODUCT_SRC = 'apps/product/src';

/** `apps/product/src` 配下の .ts / .tsx を読み込む（生成物も含めて 1 回だけ走査）。 */
export function collectProductSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  // dot ディレクトリを一律で飛ばすと `app/.well-known/**` の route を落とす（#2775）
  const skipped = new Set(['node_modules', '.next', '.turbo', '.git', '.vercel']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skipped.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        files.push({ path: relative(root, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(root, PRODUCT_SRC));
  return files;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function checkGlossaryReferences(
  glossary: readonly GlossaryEntry[],
  schema: SchemaModel,
  sources: SourceFile[],
  root: string,
): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];
  const source = (entry: GlossaryEntry): string => `glossary:${entry.id}`;

  for (const entry of glossary) {
    if (entry.code?.feature) {
      const dir = join(root, PRODUCT_SRC, 'features', entry.code.feature);
      if (!existsSync(dir)) {
        violations.push({
          source: source(entry),
          reason: `code.feature '${entry.code.feature}' の dir がありません: ${PRODUCT_SRC}/features/${entry.code.feature}`,
        });
      }
    }

    for (const identifier of entry.code?.identifiers ?? []) {
      // `'low' | 'medium' | 'high'` のような型リテラルは識別子ではないので検査しない
      if (!IDENTIFIER.test(identifier)) continue;
      const pattern = new RegExp(`\\b${identifier.replace(/\$/g, '\\$')}\\b`);
      if (!sources.some((file) => pattern.test(file.text))) {
        violations.push({
          source: source(entry),
          reason: `code.identifiers '${identifier}' が ${PRODUCT_SRC} に見つかりません`,
        });
      }
    }

    for (const ref of entry.db ?? []) {
      const [tableName, columnName, ...rest] = ref.split('.');
      if (rest.length > 0) {
        violations.push({
          source: source(entry),
          reason: `db '${ref}' の形式が table[.column] ではありません`,
        });
        continue;
      }
      const table = findTable(schema, tableName);
      if (columnName === undefined) {
        if (table === undefined && !schema.functions.includes(tableName)) {
          violations.push({
            source: source(entry),
            reason: `db '${ref}' は public のテーブルにも関数にもありません`,
          });
        }
        continue;
      }
      if (table === undefined) {
        violations.push({
          source: source(entry),
          reason: `db '${ref}' のテーブル ${tableName} がありません`,
        });
      } else if (!table.columns.some((column) => column.name === columnName)) {
        violations.push({
          source: source(entry),
          reason: `db '${ref}' の列 ${columnName} が ${tableName} にありません`,
        });
      }
    }
  }

  return violations;
}

export function checkTimeRuleMirrorReferences(
  mirrors: readonly TimeRuleMirror[],
  sources: SourceFile[],
): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];
  const byPath = new Map(sources.map((file) => [file.path, file.text]));

  for (const mirror of mirrors) {
    const source = `invariants:時刻:${mirror.paths.join(' + ')}`;
    const texts: string[] = [];
    for (const path of mirror.paths) {
      const text = byPath.get(`${PRODUCT_SRC}/${path}`);
      if (text === undefined) {
        violations.push({ source, reason: `path がありません: ${PRODUCT_SRC}/${path}` });
      } else {
        texts.push(text);
      }
    }
    for (const symbol of mirror.symbols) {
      if (!texts.some((text) => text.includes(symbol))) {
        violations.push({ source, reason: `symbol '${symbol}' が場所の file に見つかりません` });
      }
    }
  }

  return violations;
}
