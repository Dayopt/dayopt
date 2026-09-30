import { describe, expect, it } from 'vitest';
import { failureCode, ReadFailure, sanitize } from './safety';

describe('doctor output safety', () => {
  it('removes known secrets and credential fields recursively', () => {
    const result = JSON.stringify(
      sanitize(
        {
          secret: 'opaque-secret',
          nested: [{ token: 'opaque-token', note: 'fake-opaque-value' }],
          provider: 'sk_test_FAKE_SENTINEL',
        },
        ['fake-opaque-value'],
      ),
    );
    for (const sentinel of [
      'opaque-secret',
      'opaque-token',
      'fake-opaque-value',
      'sk_test_FAKE_SENTINEL',
    ])
      expect(result).not.toContain(sentinel);
  });
  it('removes URL userinfo, query, fragment and arbitrary credential paths', () => {
    const result = JSON.stringify(
      sanitize({
        endpoint:
          'https://FAKE_USERNAME:FAKE_PASSWORD@example.test/api/webhooks/stripe?secret=FAKE_QUERY#FAKE_FRAGMENT',
        other: 'https://example.test/deploy-hook/FAKE_PATH_SECRET',
      }),
    );
    for (const sentinel of [
      'FAKE_USERNAME',
      'FAKE_PASSWORD',
      'FAKE_QUERY',
      'FAKE_FRAGMENT',
      'FAKE_PATH_SECRET',
    ])
      expect(result).not.toContain(sentinel);
    expect(result).toContain('https://example.test/api/webhooks/stripe');
  });
  it('removes separate arbitrary path fields too', () => {
    const result = JSON.stringify(
      sanitize({
        endpoint: { origin: 'https://example.test', path: '/deploy-hook/FAKE_SEPARATE_PATH' },
      }),
    );
    expect(result).not.toContain('FAKE_SEPARATE_PATH');
  });
  it('redacts complete API credential names even without recognizable value prefixes', () => {
    const result = JSON.stringify(
      sanitize({
        STRIPE_SECRET_KEY: 'FAKE_OPAQUE_KEY',
        RESEND_WEBHOOK_SECRET: 'FAKE_OPAQUE_WEBHOOK',
      }),
    );
    expect(result).not.toContain('FAKE_OPAQUE_KEY');
    expect(result).not.toContain('FAKE_OPAQUE_WEBHOOK');
  });
  it('classifies failure without exposing raw provider messages', () => {
    expect(failureCode(new ReadFailure('insufficient_access', 403))).toBe('insufficient_access');
    expect(failureCode(new Error('FAKE_PRIVATE_MESSAGE'))).toBe('read_failed');
    expect(failureCode(Object.assign(new Error(), { name: 'TimeoutError' }))).toBe(
      'request_timeout',
    );
  });
});
it('keeps credential-free origin fields unchanged for cross-process comparison', () => {
  expect(sanitize({ origin: 'https://app.dayopt.app', path: '/api/health' })).toEqual({
    origin: 'https://app.dayopt.app',
    path: '/api/health',
  });
});
