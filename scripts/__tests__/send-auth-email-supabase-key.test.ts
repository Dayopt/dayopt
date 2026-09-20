import { describe, expect, it, vi } from 'vitest';

import { resolveAuthEmailSecretKey } from '../../supabase/functions/send-auth-email/supabase-key.ts';

const hostedUrl = 'https://project.supabase.co';
const modernKey = 'sb_secret_fixture-default';
const namedKey = 'sb_secret_fixture-named';
const legacyKey = 'local-jwt-fixture';

describe('auth email Supabase credential boundary', () => {
  it('uses the managed default key, independent of dictionary order', () => {
    expect(
      resolveAuthEmailSecretKey({
        supabaseUrl: hostedUrl,
        secretKeys: JSON.stringify({ mailer: namedKey, default: modernKey }),
        localServiceRoleKey: legacyKey,
      }),
    ).toBe(modernKey);
  });

  it('uses a dedicated secret key when explicitly configured', () => {
    expect(
      resolveAuthEmailSecretKey({
        supabaseUrl: hostedUrl,
        secretKey: namedKey,
        secretKeys: JSON.stringify({ default: modernKey }),
      }),
    ).toBe(namedKey);
  });

  it.each([
    '',
    '{"default":"sb_secret_private-parser-input",',
    'null',
    '[]',
    '42',
    '{}',
    JSON.stringify({ mailer: namedKey }),
    JSON.stringify({ default: null }),
    JSON.stringify({ default: legacyKey }),
    JSON.stringify({ default: 'sb_publishable_fixture' }),
    JSON.stringify({ default: '' }),
  ])('does not downgrade invalid or missing managed default: %s', (secretKeys) => {
    expect(
      resolveAuthEmailSecretKey({
        supabaseUrl: 'http://localhost:54321',
        secretKeys,
        localServiceRoleKey: legacyKey,
      }),
    ).toBeUndefined();
  });

  it('does not hide invalid dedicated config by using another credential', () => {
    expect(
      resolveAuthEmailSecretKey({
        supabaseUrl: hostedUrl,
        secretKey: legacyKey,
        secretKeys: JSON.stringify({ default: modernKey }),
      }),
    ).toBeUndefined();
  });

  it.each([
    hostedUrl,
    'http://localhost.attacker.test:54321',
    'https://kong:8000',
    'http://kong:8001',
    'http://kong.attacker.test:8000',
    'http://user:password@localhost:54321',
    'ftp://localhost',
    'not-a-url',
  ])('never uses legacy credentials for non-local URL %s', (supabaseUrl) => {
    expect(
      resolveAuthEmailSecretKey({ supabaseUrl, localServiceRoleKey: legacyKey }),
    ).toBeUndefined();
  });

  it.each([
    'http://localhost:54321',
    'http://127.0.0.1:54321',
    'http://[::1]:54321',
    'http://kong:8000',
  ])('supports the explicit CLI adapter at %s', (supabaseUrl) => {
    expect(resolveAuthEmailSecretKey({ supabaseUrl, localServiceRoleKey: legacyKey })).toBe(
      legacyKey,
    );
  });

  it('returns no credential when configuration is absent', () => {
    expect(resolveAuthEmailSecretKey({ supabaseUrl: hostedUrl })).toBeUndefined();
  });

  it('does not throw or log malformed JSON containing a secret', () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    try {
      expect(
        resolveAuthEmailSecretKey({
          supabaseUrl: hostedUrl,
          secretKeys: '{"default":"sb_secret_private-parser-input",',
        }),
      ).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
