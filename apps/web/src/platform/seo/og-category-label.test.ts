import { describe, expect, it } from 'vitest';

import { getOgCategoryLabel, normalizeOgLocale } from './og-category-label';

describe('OG category labels', () => {
  it.each([
    ['en', 'product', 'Product'],
    ['en', 'docs', 'Docs'],
    ['en', 'journal', 'Journal'],
    ['en', 'release', 'Release'],
    ['ja', 'product', 'プロダクト'],
    ['ja', 'docs', 'ドキュメント'],
    ['ja', 'journal', 'ブログ'],
    ['ja', 'release', 'リリース'],
  ] as const)('%s の %s カテゴリを翻訳する', (locale, category, label) => {
    expect(getOgCategoryLabel(locale, category)).toBe(label);
  });

  it.each([undefined, null, 'unsupported'])('%s は既定localeのenへ戻す', (locale) => {
    expect(normalizeOgLocale(locale)).toBe('en');
  });

  it('ja をそのまま受け付ける', () => {
    expect(normalizeOgLocale('ja')).toBe('ja');
  });
});
