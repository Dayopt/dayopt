import { afterEach, describe, expect, it, vi } from 'vitest';

import { OG_IMAGE_PATH, getAppUrl, getOgImageUrl } from './app-url';

describe('getOgImageUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('metadata と JSON-LD が同じ絶対 URL を参照する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.dayopt.app');

    expect(getOgImageUrl()).toBe('https://app.dayopt.app/opengraph-image');
    expect(getOgImageUrl()).toBe(`${getAppUrl()}${OG_IMAGE_PATH}`);
  });

  it('NEXT_PUBLIC_APP_URL が marketing domain でも product origin を返す（#2573）', () => {
    // production の実測値（2026-09-10）。marketing 側に /opengraph-image は無い
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dayopt.app');

    expect(getOgImageUrl()).toBe('https://app.dayopt.app/opengraph-image');
  });

  it('www も product origin へ寄せる', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.dayopt.app');

    expect(getOgImageUrl()).toBe('https://app.dayopt.app/opengraph-image');
  });

  it('preview / localhost の base はそのまま使う', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    expect(getOgImageUrl()).toBe('http://localhost:3000/opengraph-image');
  });

  it('URL として壊れた値なら product origin へ fallback する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not-a-url');

    expect(getOgImageUrl()).toBe('https://app.dayopt.app/opengraph-image');
  });

  it('OG 画像 path は locale prefix を持たない（#2573）', () => {
    // `[locale]` 配下へ入ると next-intl が locale 値として解釈して 404 になる
    expect(OG_IMAGE_PATH).toBe('/opengraph-image');
    expect(OG_IMAGE_PATH.startsWith('/en')).toBe(false);
    expect(OG_IMAGE_PATH.startsWith('/ja')).toBe(false);
  });
});
