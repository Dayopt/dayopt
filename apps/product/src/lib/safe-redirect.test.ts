import { describe, expect, it } from 'vitest';

import { getSafeLocalizedRedirectPath, getSafeRedirectPath } from './safe-redirect';

describe('getSafeRedirectPath', () => {
  it('allows same-origin relative paths', () => {
    expect(getSafeRedirectPath('/calendar?date=2026-07-06&view=week')).toBe(
      '/calendar?date=2026-07-06&view=week',
    );
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(getSafeRedirectPath('https://evil.example')).toBe('/calendar');
    expect(getSafeRedirectPath('//evil.example/path')).toBe('/calendar');
    expect(getSafeRedirectPath('/%2F%2Fevil.example/path')).toBe('/calendar');
  });

  it('rejects raw and encoded backslash redirects', () => {
    expect(getSafeRedirectPath('/\\evil.example/path')).toBe('/calendar');
    expect(getSafeRedirectPath('/%5C%5Cevil.example/path')).toBe('/calendar');
    expect(getSafeRedirectPath('/%5cevil.example/path')).toBe('/calendar');
  });

  it('rejects decoded scheme payloads', () => {
    expect(getSafeRedirectPath('/https%3A%2F%2Fevil.example')).toBe('/calendar');
  });
});

describe('getSafeLocalizedRedirectPath', () => {
  it('adds the current locale to an unlocalized path', () => {
    expect(getSafeLocalizedRedirectPath('/settings', 'ja')).toBe('/ja/settings');
  });

  it.each(['/ja/settings', '/ja?panel=settings', '/en/report?range=year'])(
    'does not duplicate an existing locale prefix: %s',
    (path) => {
      expect(getSafeLocalizedRedirectPath(path, 'ja')).toBe(path);
    },
  );

  it('uses the default locale when the route locale is unsupported', () => {
    expect(getSafeLocalizedRedirectPath('/settings', 'unsupported')).toBe('/en/settings');
  });

  it('localizes the safe fallback for an external redirect', () => {
    expect(getSafeLocalizedRedirectPath('https://evil.example', 'ja')).toBe('/ja/calendar');
  });
});
