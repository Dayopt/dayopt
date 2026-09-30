import { describe, expect, it } from 'vitest';
import { previewRequestTarget, validatePreviewOrigin } from './preview-access';

const origin = 'https://product-abc123-dayopt.vercel.app';
const ref = 'abcdefghijklmnopqrst';

describe('Preview request routing', () => {
  it('bypassは候補の同一originだけ', () => {
    expect(previewRequestTarget(`${origin}/api/trpc/x`, origin, ref)).toBe('preview');
    expect(previewRequestTarget(`https://${ref}.supabase.co/auth/v1/token`, origin, ref)).toBe(
      'supabase',
    );
    expect(previewRequestTarget('https://challenges.cloudflare.com/test', origin, ref)).toBe(
      'captcha',
    );
  });
  it.each([
    'https://app.dayopt.app',
    'https://evil.example',
    'http://product-abc123-dayopt.vercel.app',
    `${origin}.evil.example`,
    'https://yvglwblxrnrenfifsnje.supabase.co',
  ])('他originを拒否: %s', (url) => {
    expect(previewRequestTarget(url, origin, ref)).toBe('blocked');
  });
  it.each([
    undefined,
    'https://app.dayopt.app',
    'https://product-git-main-dayopt.vercel.app',
    `${origin}/`,
    `${origin}?secret=x`,
  ])('可変aliasや不正originを拒否', (url) => {
    expect(() => validatePreviewOrigin(url)).toThrow();
  });
  it('指定deployment URLを受理', () => expect(validatePreviewOrigin(origin)).toBe(origin));
});
