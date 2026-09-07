import { describe, expect, it } from 'vitest';

import {
  buildValueRules,
  renderGeneratedSections,
  validateRegistry,
  type Locale,
} from '../lib/glossary/core';
import { GLOSSARY, KEY_NAME_RULES } from '../lib/glossary/terms';

/**
 * 用語集レジストリの契約テスト。
 *
 * 旧 check-glossary.ts は「glossary.md と同期」とコメントしながら手書きの定数を
 * 持ち、`タスク` の推奨語が別の禁止語「エントリ」になっていた。個別に直すのでは
 * なく、そのクラスの矛盾がレジストリに入らないことをここで固定する。
 */

describe('レジストリ自己検査', () => {
  it('validateRegistry が違反を報告しない', () => {
    expect(validateRegistry(GLOSSARY, KEY_NAME_RULES)).toEqual([]);
  });

  it('id が一意で kebab-case', () => {
    const ids = GLOSSARY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('ui / design の概念は ja と en を持つ', () => {
    for (const entry of GLOSSARY) {
      if (entry.layer === 'code') continue;
      expect(entry.ja, `${entry.id} の ja`).toBeTruthy();
      expect(entry.en, `${entry.id} の en`).toBeTruthy();
    }
  });

  it('禁止語の正規表現がすべて compile できる', () => {
    for (const locale of ['ja', 'en'] as const) {
      expect(() => buildValueRules(GLOSSARY, locale)).not.toThrow();
    }
  });

  it('廃止予定の概念は禁止語を持たない（撤去前に語彙を強制しない）', () => {
    for (const entry of GLOSSARY) {
      if (entry.status !== 'planned-removal') continue;
      expect(entry.forbidden ?? [], `${entry.id}`).toHaveLength(0);
    }
  });
});

describe('正解語が禁止語に当たらない', () => {
  const locales: readonly Locale[] = ['ja', 'en'];

  it.each(locales)('%s の正解語がどの有効な禁止語にもマッチしない', (locale) => {
    // validateRegistry の同名検査と重複するが、退行したときに
    // 「どの語が」ではなく「この不変条件が」壊れたと読める形で残す。
    const problems = validateRegistry(GLOSSARY, KEY_NAME_RULES).filter((problem) =>
      problem.startsWith(`正解語が禁止語に当たる (${locale})`),
    );
    expect(problems).toEqual([]);
  });

  it('「ブロック」は正解語「タイムブロック」を巻き込まない', () => {
    const rule = buildValueRules(GLOSSARY, 'ja').find((r) => r.term === 'ブロック');
    expect(rule?.regex?.test('タイムブロックを削除')).toBe(false);
    expect(rule?.regex?.test('ブロックを削除')).toBe(true);
  });

  it('「箱」はゴミ箱を巻き込まない / 「束」は約束を巻き込まない', () => {
    const rules = buildValueRules(GLOSSARY, 'ja');
    const box = rules.find((r) => r.term === '箱');
    const bundle = rules.find((r) => r.term === '束');
    expect(box?.regex?.test('ゴミ箱を空にする')).toBe(false);
    expect(box?.regex?.test('1 箱の中央値')).toBe(true);
    expect(bundle?.regex?.test('保護することをお約束します')).toBe(false);
    expect(bundle?.regex?.test('束を選ぶ')).toBe(true);
  });

  it('en の block は timeblock を巻き込まない', () => {
    const rule = buildValueRules(GLOSSARY, 'en').find((r) => r.term === 'block');
    expect(rule?.regex?.test('Delete all timeblocks')).toBe(false);
    expect(rule?.regex?.test('Delete all blocks')).toBe(true);
  });
});

describe('生成物の契約', () => {
  const rendered = renderGeneratedSections(GLOSSARY, KEY_NAME_RULES);

  it('外部が参照するアンカー「禁止表記一覧」を持つ', () => {
    // .agents/skills/i18n/SKILL.md と docs/engineering/i18n.md が
    // docs/product/glossary.md#禁止表記一覧 を名指ししている。
    expect(rendered).toContain('## 禁止表記一覧');
  });

  it('すべての ui / design 概念が表に載る', () => {
    for (const entry of GLOSSARY) {
      if (entry.layer === 'code') continue;
      expect(rendered, `${entry.id}`).toContain(entry.concept);
    }
  });

  it('廃止予定の概念が「廃止予定」節に出る', () => {
    expect(rendered).toContain('### 廃止予定');
    expect(rendered).toContain('Skip');
  });
});
