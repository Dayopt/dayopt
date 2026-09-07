import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildValueRules,
  compileKeyNameRules,
  getAllStringValues,
  scanKeyNames,
  scanValues,
  tokenizeKeyPath,
  violatesValueRule,
  type ForbiddenTerm,
  type GlossaryEntry,
  type KeyNameRule,
  type MessageValue,
} from '../lib/glossary/core';

/**
 * copy:check の判定コアのテスト。
 *
 * CLI 側は messages を読んでこの pure function に渡すだけなので、判定は
 * すべてここで固定する。最後の 1 本だけは実 repo に対して CLI を子プロセス
 * 実行し、「現行 messages で strict が緑」という CI の前提を守る。
 */

function entry(id: string, forbidden: readonly ForbiddenTerm[]): GlossaryEntry {
  return {
    id,
    layer: 'ui',
    status: 'current',
    concept: id,
    ja: `${id}-ja`,
    en: `${id}-en`,
    usage: 'test',
    forbidden,
  };
}

function value(keyPath: string, text: string, namespace = 'calendar'): MessageValue {
  return { namespace, keyPath, value: text };
}

describe('値の判定', () => {
  it('substring（既定）は部分一致する', () => {
    const rules = buildValueRules(
      [entry('a', [{ term: 'タグ', locale: 'ja', enforcement: 'active', reason: 'r' }])],
      'ja',
    );
    expect(violatesValueRule(rules[0]!, value('k', 'タグを追加'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', 'アクティビティを追加'))).toBe(false);
  });

  it("match: 'word' は語境界で判定し、複合語を巻き込まない", () => {
    const rules = buildValueRules(
      [
        entry('a', [
          { term: 'block', locale: 'en', enforcement: 'migration', match: 'word', reason: 'r' },
        ]),
      ],
      'en',
    );
    expect(violatesValueRule(rules[0]!, value('k', 'Delete block'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', 'Delete blocks'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', 'Delete timeblock'))).toBe(false);
  });

  it('pattern は自前の正規表現で判定する（lookbehind を含む）', () => {
    const rules = buildValueRules(
      [
        entry('a', [
          {
            term: 'ブロック',
            locale: 'ja',
            enforcement: 'migration',
            pattern: '(?<!タイム)ブロック',
            reason: 'r',
          },
        ]),
      ],
      'ja',
    );
    expect(violatesValueRule(rules[0]!, value('k', 'ブロックを検索'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', 'タイムブロックを検索'))).toBe(false);
  });

  it('allowIfValueIncludes に当たる値は許容する', () => {
    const rules = buildValueRules(
      [
        entry('a', [
          {
            term: 'レビュー',
            locale: 'ja',
            enforcement: 'active',
            allowIfValueIncludes: ['プレビュー'],
            reason: 'r',
          },
        ]),
      ],
      'ja',
    );
    expect(violatesValueRule(rules[0]!, value('k', 'レビューを開く'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', 'プレビュー:'))).toBe(false);
  });

  it('allowKeyPaths に当たるキーは許容する（外部契約の据え置き）', () => {
    const rules = buildValueRules(
      [
        entry('a', [
          {
            term: 'entry',
            locale: 'en',
            enforcement: 'migration',
            pattern: '\\b(entry|entries)\\b',
            allowKeyPaths: ['^oauth\\.consent\\.scope\\.'],
            reason: 'r',
          },
        ]),
      ],
      'en',
    );
    expect(violatesValueRule(rules[0]!, value('calendar.entries', 'Read entries'))).toBe(true);
    expect(
      violatesValueRule(rules[0]!, value('oauth.consent.scope.read:entries', 'Read entries')),
    ).toBe(false);
  });

  it('onlyNamespaces を指定した語は他 namespace を見ない（同音異義）', () => {
    const rules = buildValueRules(
      [
        entry('a', [
          {
            term: '空白',
            locale: 'ja',
            enforcement: 'migration',
            onlyNamespaces: ['report'],
            reason: 'r',
          },
        ]),
      ],
      'ja',
    );
    expect(violatesValueRule(rules[0]!, value('k', '空白の時間', 'report'))).toBe(true);
    expect(violatesValueRule(rules[0]!, value('k', '改行や空白のみ', 'common'))).toBe(false);
  });

  it('context-only は判定に載せない', () => {
    const rules = buildValueRules(
      [entry('a', [{ term: '計画', locale: 'ja', enforcement: 'context-only', reason: 'r' }])],
      'ja',
    );
    expect(rules).toHaveLength(0);
  });

  it('locale が違うルールは混ざらない', () => {
    const glossary = [
      entry('a', [{ term: 'タグ', locale: 'ja', enforcement: 'active', reason: 'r' }]),
    ];
    expect(buildValueRules(glossary, 'en')).toHaveLength(0);
    expect(buildValueRules(glossary, 'ja')).toHaveLength(1);
  });

  it('scanValues は違反した値だけを返す', () => {
    const rules = buildValueRules(
      [entry('a', [{ term: 'タグ', locale: 'ja', enforcement: 'active', reason: 'r' }])],
      'ja',
    );
    const findings = scanValues(
      [value('k1', 'タグを追加'), value('k2', 'アクティビティを追加')],
      rules,
      'ja',
    );
    expect(findings.map((f) => f.keyPath)).toEqual(['k1']);
    expect(findings[0]?.preferred).toBe('a-ja');
  });
});

describe('キー名の token 分解', () => {
  it('camelCase 境界と非英数字で割る', () => {
    expect(tokenizeKeyPath('settings.dataControls.export.tasksEvents')).toEqual([
      'settings',
      'data',
      'controls',
      'export',
      'tasks',
      'events',
    ]);
    expect(tokenizeKeyPath('oauth.consent.scope.read:entries')).toEqual([
      'oauth',
      'consent',
      'scope',
      'read',
      'entries',
    ]);
  });

  it('完全一致なので ariaLabel の label や sentryReport の entry を誤検知しない', () => {
    expect(tokenizeKeyPath('calendar.aria.closeAriaLabel')).not.toContain('entry');
    expect(tokenizeKeyPath('error.global.sentryReport')).not.toContain('entry');
    expect(tokenizeKeyPath('error.global.sentryReport')).toContain('sentry');
  });
});

describe('キー名の判定', () => {
  const rules: readonly KeyNameRule[] = [
    {
      token: 'entry',
      preferred: 'timeblock',
      enforcement: 'migration',
      allowKeyPaths: ['manualEntry$'],
      reason: 'r',
    },
    { token: 'task', preferred: 'timeblock', enforcement: 'migration', reason: 'r' },
    { token: 'skipme', preferred: 'x', enforcement: 'context-only', reason: 'r' },
  ];
  const compiled = compileKeyNameRules(rules);

  it('context-only の rule は compile されない', () => {
    expect(compiled.map((r) => r.token)).toEqual(['entry', 'task']);
  });

  it('旧語彙の token を検出し、allowKeyPaths は許容する', () => {
    const findings = scanKeyNames(
      [
        value('timeblock.inspector.linkEntry', 'x'),
        value('settings.account.mfa.setup.manualEntry', 'x'),
        value('calendar.event.newTask', 'x'),
        value('calendar.aria.closeAriaLabel', 'x'),
      ],
      compiled,
      'ja',
    );
    expect(findings.map((f) => f.keyPath)).toEqual([
      'timeblock.inspector.linkEntry',
      'calendar.event.newTask',
    ]);
  });
});

describe('JSON 走査', () => {
  it('ネストした leaf をキーパス付きで集める', () => {
    expect(getAllStringValues({ a: { b: 'x' }, c: ['y'] })).toEqual([
      { keyPath: 'a.b', value: 'x' },
      { keyPath: 'c[0]', value: 'y' },
    ]);
  });
});

describe('実 repo に対する CLI', () => {
  it('現行 messages で copy:check --strict が exit 0（active 違反ゼロ）', () => {
    const result = spawnSync('npx', ['tsx', 'scripts/tasks/check-glossary.ts', '--strict'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // 違反ゼロの時は早期 return して「✅ 禁止表記なし」だけを出すので、
    // 合計行の有無ではなく「active 違反の見出しが出ていない」ことで判定する。
    expect(result.stdout, result.stdout + result.stderr).not.toContain('⚠️  禁止表記');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
