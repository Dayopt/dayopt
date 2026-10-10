/**
 * DB の列挙型 CHECK 制約と、TS 側の登録表を突き合わせる純粋関数（#3092）。
 *
 * 値の集合は TS 定数を正本にし、DB の CHECK は migration で写す。この関数は両者の
 * ずれを、どちらをどう直すかが分かる文面で返す。
 *
 * @see docs/engineering/conventions.md §正本と派生（判断と展開の分離）
 */

/** 登録表の 1 項目。キーは `<schema>.<table>.<constraint>`。 */
export type CheckConstraintEntry =
  /** TS が値を扱う。`values` は TS の正本定数から渡す。 */
  | { source: 'ts'; values: readonly (string | number)[] }
  /** DB の内部状態だけで使う値。DB が正本で、TS の写しは作らない。 */
  | { source: 'db'; reason: string }
  /** 複合条件で、値の集合として比べられない。 */
  | { source: 'excluded'; reason: string };

export type CheckConstraintRegistry = Readonly<Record<string, CheckConstraintEntry>>;

export interface CheckConstraintRow {
  schema: string;
  table: string;
  name: string;
  /** `pg_get_constraintdef(oid)` の結果。 */
  definition: string;
}

const REGISTRY_FILE = 'src/lib/test/integration/check-constraint-registry.ts';

function constraintKey(row: Pick<CheckConstraintRow, 'schema' | 'table' | 'name'>): string {
  return `${row.schema}.${row.table}.${row.name}`;
}

/**
 * `pg_get_constraintdef` の `ARRAY[...]` に並ぶ値を取り出す。
 * 文字列（`'a'::text`、`'it''s'::character varying`）と整数を読み、文字列として返す。
 */
export function parseEnumeratedValues(definition: string): string[] {
  const values: string[] = [];
  for (const match of definition.matchAll(/ARRAY\[([^\]]*)\]/g)) {
    const body = match[1] ?? '';
    for (const item of body.matchAll(/'((?:[^']|'')*)'|(-?\d+)/g)) {
      if (item[1] !== undefined) values.push(item[1].replaceAll("''", "'"));
      else if (item[2] !== undefined) values.push(item[2]);
    }
  }
  return values;
}

function formatList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/**
 * DB の制約一覧と登録表のずれを、修正方法を含む文面の配列で返す。空なら一致。
 */
export function diffCheckConstraintRegistry(
  rows: readonly CheckConstraintRow[],
  registry: CheckConstraintRegistry,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = constraintKey(row);
    seen.add(key);
    const entry = registry[key];
    if (!entry) {
      problems.push(
        `CHECK ${row.name}（${row.schema}.${row.table}）が登録表にありません。` +
          `${REGISTRY_FILE} に "${key}" を追加し、source（ts / db / excluded）を指定してください。` +
          ` DB の定義: ${row.definition}`,
      );
      continue;
    }
    if (entry.source !== 'ts') continue;

    const dbValues = new Set(parseEnumeratedValues(row.definition));
    const tsValues = new Set(entry.values.map(String));
    const dbOnly = [...dbValues].filter((value) => !tsValues.has(value)).sort();
    const tsOnly = [...tsValues].filter((value) => !dbValues.has(value)).sort();
    if (dbOnly.length > 0 || tsOnly.length > 0) {
      problems.push(
        `CHECK ${row.name}（${row.schema}.${row.table}）と TS 正本が一致しません。` +
          `DB のみ: ${formatList(dbOnly)} / TS のみ: ${formatList(tsOnly)}。` +
          'TS を正本として、新しい migration で CHECK を再作成してください。',
      );
    }
  }

  for (const key of Object.keys(registry).sort()) {
    if (!seen.has(key)) {
      problems.push(
        `登録表の "${key}" に対応する CHECK が DB にありません。` +
          `制約を削除したなら ${REGISTRY_FILE} から外してください。`,
      );
    }
  }

  return problems;
}
