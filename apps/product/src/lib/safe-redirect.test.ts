import { describe, expect, it } from 'vitest';

import { getSafeLocalizedRedirectPath, getSafeRedirectPath } from './safe-redirect';

describe('getSafeRedirectPath', () => {
  it('allows same-origin relative paths', () => {
    expect(getSafeRedirectPath('/?date=2026-07-06&view=week')).toBe('/?date=2026-07-06&view=week');
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(getSafeRedirectPath('https://evil.example')).toBe('/');
    expect(getSafeRedirectPath('//evil.example/path')).toBe('/');
    expect(getSafeRedirectPath('/%2F%2Fevil.example/path')).toBe('/');
  });

  it('rejects raw and encoded backslash redirects', () => {
    expect(getSafeRedirectPath('/\\evil.example/path')).toBe('/');
    expect(getSafeRedirectPath('/%5C%5Cevil.example/path')).toBe('/');
    expect(getSafeRedirectPath('/%5cevil.example/path')).toBe('/');
  });

  it('rejects decoded scheme payloads', () => {
    expect(getSafeRedirectPath('/https%3A%2F%2Fevil.example')).toBe('/');
  });
});

describe('getSafeLocalizedRedirectPath', () => {
  it('adds the current locale to an unlocalized path', () => {
    expect(getSafeLocalizedRedirectPath('/settings', 'ja')).toBe('/ja/settings');
  });

  it.each(['/ja/settings', '/ja/?view=day', '/en/settings'])(
    'does not duplicate an existing locale prefix: %s',
    (path) => {
      expect(getSafeLocalizedRedirectPath(path, 'ja')).toBe(path);
    },
  );

  it('uses the default locale when the route locale is unsupported', () => {
    expect(getSafeLocalizedRedirectPath('/settings', 'unsupported')).toBe('/en/settings');
  });

  it('localizes the safe fallback for an external redirect', () => {
    expect(getSafeLocalizedRedirectPath('https://evil.example', 'ja')).toBe('/ja/');
  });
});
