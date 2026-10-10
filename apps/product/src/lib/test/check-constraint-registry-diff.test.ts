import { describe, expect, it } from 'vitest';

import {
  diffCheckConstraintRegistry,
  parseEnumeratedValues,
  type CheckConstraintRow,
} from './check-constraint-registry-diff';

const colorRow: CheckConstraintRow = {
  schema: 'public',
  table: 'categories',
  name: 'categories_color_valid',
  definition: "CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'blue'::text]))))",
};

describe('parseEnumeratedValues', () => {
  it('NULL を許す文字列の列挙から値だけを読む', () => {
    expect(parseEnumeratedValues(colorRow.definition)).toEqual(['red', 'blue']);
  });

  it('整数の列挙を文字列として読む', () => {
    expect(parseEnumeratedValues('CHECK ((week_starts_on = ANY (ARRAY[0, 1, 6])))')).toEqual([
      '0',
      '1',
      '6',
    ]);
  });

  it('配列の包含（<@）と型 cast・引用符のエスケープを読む', () => {
    expect(
      parseEnumeratedValues(
        "CHECK ((enabled_client_ids <@ ARRAY['claude-ai'::character varying, 'it''s'::text]))",
      ),
    ).toEqual(['claude-ai', "it's"]);
  });
});

describe('diffCheckConstraintRegistry', () => {
  it('集合が一致すれば空を返す（順序は問わない）', () => {
    expect(
      diffCheckConstraintRegistry([colorRow], {
        'public.categories.categories_color_valid': { source: 'ts', values: ['blue', 'red'] },
      }),
    ).toEqual([]);
  });

  it('未登録の制約は、追加先と source の指定を求める', () => {
    const [problem, ...rest] = diffCheckConstraintRegistry([colorRow], {});
    expect(rest).toEqual([]);
    expect(problem).toContain(
      'CHECK categories_color_valid（public.categories）が登録表にありません',
    );
    expect(problem).toContain('"public.categories.categories_color_valid" を追加し');
    expect(problem).toContain('source（ts / db / excluded）');
  });

  it('DB だけ・TS だけにある値を分けて示し、migration での再作成を求める', () => {
    expect(
      diffCheckConstraintRegistry([colorRow], {
        'public.categories.categories_color_valid': { source: 'ts', values: ['red', 'rose'] },
      }),
    ).toEqual([
      'CHECK categories_color_valid（public.categories）と TS 正本が一致しません。' +
        'DB のみ: ["blue"] / TS のみ: ["rose"]。TS を正本として、新しい migration で CHECK を再作成してください。',
    ]);
  });

  it('整数の正本は文字列化して比べる', () => {
    const row: CheckConstraintRow = {
      schema: 'public',
      table: 'user_settings',
      name: 'user_settings_week_starts_on_check',
      definition: 'CHECK ((week_starts_on = ANY (ARRAY[0, 1, 6])))',
    };
    expect(
      diffCheckConstraintRegistry([row], {
        'public.user_settings.user_settings_week_starts_on_check': {
          source: 'ts',
          values: [0, 1, 6],
        },
      }),
    ).toEqual([]);
  });

  it('db / excluded の項目は値を比べない', () => {
    expect(
      diffCheckConstraintRegistry([colorRow], {
        'public.categories.categories_color_valid': { source: 'db', reason: 'test' },
      }),
    ).toEqual([]);
  });

  it('登録表だけにある項目は、登録表からの削除を求める', () => {
    expect(
      diffCheckConstraintRegistry([], {
        'public.categories.categories_color_valid': { source: 'excluded', reason: 'test' },
      }),
    ).toEqual([
      '登録表の "public.categories.categories_color_valid" に対応する CHECK が DB にありません。' +
        '制約を削除したなら src/lib/test/integration/check-constraint-registry.ts から外してください。',
    ]);
  });
});
