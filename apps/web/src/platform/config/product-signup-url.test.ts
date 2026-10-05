import { dayoptProductUrls } from '@dayopt/config';
import { describe, expect, it } from 'vitest';

import { productLoginUrl, productSignupUrl } from './product-signup-url';

describe('productSignupUrl', () => {
  it('uses the matching Product deployment for login', () => {
    expect(productLoginUrl('')).toBe(new URL('/auth/login', dayoptProductUrls.signup).href);
    expect(productLoginUrl('https://product-preview.vercel.app')).toBe(
      'https://product-preview.vercel.app/auth/login',
    );
    expect(() => productLoginUrl('https://example.com/path')).toThrow();
  });
  it('uses the production Product URL when no override exists', () => {
    expect(productSignupUrl('')).toBe(dayoptProductUrls.signup);
  });

  it('keeps Preview registration on the matching Product deployment', () => {
    expect(productSignupUrl('https://product-preview.vercel.app')).toBe(
      'https://product-preview.vercel.app/auth/signup',
    );
  });

  it.each(['http://product-preview.vercel.app', 'https://example.com/path', 'javascript:alert(1)'])(
    'rejects a non-origin override: %s',
    (origin) => {
      expect(() => productSignupUrl(origin)).toThrow();
    },
  );
});
