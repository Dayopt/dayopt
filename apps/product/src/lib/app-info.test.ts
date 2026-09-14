import { describe, expect, it } from 'vitest';

import { getReleaseNotesUrl } from './app-info';

describe('getReleaseNotesUrl', () => {
  // repository は非公開のため、ユーザー向けのリリースノートは marketing site の公開ページを指す
  it.each([
    ['ja', 'https://dayopt.app/ja/blog/release'],
    ['en', 'https://dayopt.app/en/blog/release'],
  ])('locale=%s は marketing site の release カテゴリを返す', (locale, expected) => {
    expect(getReleaseNotesUrl(locale)).toBe(expected);
  });
});
