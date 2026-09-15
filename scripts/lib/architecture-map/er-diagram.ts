/**
 * schema model → Mermaid `erDiagram` / テーブル一覧表。
 *
 * 図は view であり正本ではない。同じ model から「全テーブル」と「概念に紐づくテーブル」の
 * 2 枚を出し、巨大図 1 枚に寄せない（#2775 基本原則 2）。
 */

import type { SchemaModel, SchemaTable } from './schema-model.ts';

/** TypeScript の型テキストを Mermaid の attribute type（識別子 1 語）へ寄せる。 */
export function toMermaidType(tsType: string): string {
  const trimmed = tsType.trim();
  if (trimmed === 'Json') return 'json';
  if (trimmed.endsWith('[]')) return `${toMermaidType(trimmed.slice(0, -2))}_array`;
  const enumMatch = trimmed.match(/\['Enums'\]\['([^']+)'\]$/);
  if (enumMatch) return `enum_${enumMatch[1]}`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function selectTables(model: SchemaModel, names?: readonly string[]): SchemaTable[] {
  if (names === undefined) return model.tables;
  const wanted = new Set(names);
  return model.tables.filter((table) => wanted.has(table.name));
}

/**
 * Mermaid erDiagram を描く。`tables` を渡すとその部分集合だけを描き、
 * 部分集合の外へ向かう FK は省く（外側は全体図で見る）。
 */
export function renderErDiagram(model: SchemaModel, tables?: readonly string[]): string {
  const selected = selectTables(model, tables);
  const selectedNames = new Set(selected.map((table) => table.name));
  const lines: string[] = ['erDiagram'];

  for (const table of selected) {
    const foreignKeyColumns = new Set(
      table.relationships.flatMap((relationship) => relationship.columns),
    );
    lines.push(`  ${table.name} {`);
    for (const column of table.columns) {
      const keys = foreignKeyColumns.has(column.name) ? ' FK' : '';
      const comment = column.nullable ? ' "nullable"' : '';
      lines.push(`    ${toMermaidType(column.type)} ${column.name}${keys}${comment}`);
    }
    lines.push('  }');
  }

  for (const table of selected) {
    for (const relationship of table.relationships) {
      if (!selectedNames.has(relationship.referencedTable)) continue;
      const cardinality = relationship.isOneToOne ? '||--||' : '}o--||';
      lines.push(
        `  ${table.name} ${cardinality} ${relationship.referencedTable} : "${relationship.columns.join(', ')}"`,
      );
    }
  }

  return lines.join('\n');
}

/** テーブル名 / 列数 / FK 参照先の一覧表（Markdown）。 */
export function renderTableIndex(model: SchemaModel): string {
  const lines = ['| テーブル | 列数 | FK 参照先 |', '| --- | --- | --- |'];
  for (const table of model.tables) {
    const targets = [...new Set(table.relationships.map((r) => r.referencedTable))].sort();
    lines.push(
      `| \`${table.name}\` | ${table.columns.length} | ${targets.length > 0 ? targets.map((t) => `\`${t}\``).join(', ') : '—'} |`,
    );
  }
  return lines.join('\n');
}
