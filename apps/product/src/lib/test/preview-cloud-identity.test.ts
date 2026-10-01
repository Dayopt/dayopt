import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ expect: vi.fn() }));

import { createCriticalPathIdentity, seedCriticalPathUser } from './e2e/critical-path-fixture';
import { resolvePreviewCloudUserId } from './preview-cloud-identity';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const DESKTOP_ID = '22222222-2222-4222-8222-222222222222';
const MOBILE_ID = '33333333-3333-4333-8333-333333333333';
const SEED_ID = '00000000-0000-0000-0000-000000000001';

const CLOUD_ENV = {
  E2E_PREVIEW_CLOUD_INTENT: '1',
  E2E_PREVIEW_RUN_ID: RUN_ID,
  E2E_PREVIEW_DESKTOP_USER_ID: DESKTOP_ID,
  E2E_PREVIEW_MOBILE_USER_ID: MOBILE_ID,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Preview Cloud synthetic identity', () => {
  it('keeps local identities random and permits existing non-Cloud fixture prefixes', () => {
    vi.stubEnv('E2E_PREVIEW_CLOUD_INTENT', '0');
    expect(resolvePreviewCloudUserId('unit', {})).toBeUndefined();
    expect(resolvePreviewCloudUserId('critical-path', {})).toBeUndefined();
    expect(createCriticalPathIdentity('unit').userId).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it('binds canonical desktop and mobile fixtures to their predetermined Cloud IDs', () => {
    expect(resolvePreviewCloudUserId('critical-path', CLOUD_ENV)).toBe(DESKTOP_ID);
    expect(resolvePreviewCloudUserId('mobile-critical-path', CLOUD_ENV)).toBe(MOBILE_ID);

    for (const [key, value] of Object.entries(CLOUD_ENV)) vi.stubEnv(key, value);
    const desktop = createCriticalPathIdentity('critical-path');
    const mobile = createCriticalPathIdentity('mobile-critical-path');
    expect(desktop.userId).toBe(DESKTOP_ID);
    expect(mobile.userId).toBe(MOBILE_ID);
    expect(desktop.email).toMatch(/^critical-path-/);
    expect(mobile.email).toMatch(/^mobile-critical-path-/);
    expect(desktop.password).not.toBe(DESKTOP_ID);
    expect(mobile.password).not.toBe(MOBILE_ID);
  });

  it('rejects Cloud intent with a noncanonical fixture prefix', () => {
    expect(() => resolvePreviewCloudUserId('unit', CLOUD_ENV)).toThrow(
      'Preview Cloud identity configuration is invalid',
    );
    expect(() => resolvePreviewCloudUserId('__proto__', CLOUD_ENV)).toThrow(
      'Preview Cloud identity configuration is invalid',
    );
    for (const [key, value] of Object.entries(CLOUD_ENV)) vi.stubEnv(key, value);
    expect(() => createCriticalPathIdentity('unit')).toThrow(
      'Preview Cloud identity configuration is invalid',
    );
  });

  it.each([
    ['run ID is invalid', { ...CLOUD_ENV, E2E_PREVIEW_RUN_ID: 'invalid' }],
    ['desktop ID is missing', { ...CLOUD_ENV, E2E_PREVIEW_DESKTOP_USER_ID: '' }],
    ['mobile ID is missing', { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: '' }],
    ['desktop ID is invalid', { ...CLOUD_ENV, E2E_PREVIEW_DESKTOP_USER_ID: 'invalid' }],
    ['mobile ID is invalid', { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: 'invalid' }],
    ['IDs are identical', { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: DESKTOP_ID }],
    ['desktop ID is the seed user', { ...CLOUD_ENV, E2E_PREVIEW_DESKTOP_USER_ID: SEED_ID }],
    ['mobile ID is the seed user', { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: SEED_ID }],
  ])('rejects Cloud identity when %s', (_reason, env) => {
    expect(() => resolvePreviewCloudUserId('critical-path', env)).toThrow(
      'Preview Cloud identity configuration is invalid',
    );
  });

  it('rejects unknown Cloud intent flags instead of silently falling back to random IDs', () => {
    expect(() =>
      resolvePreviewCloudUserId('critical-path', {
        ...CLOUD_ENV,
        E2E_PREVIEW_CLOUD_INTENT: 'true',
      }),
    ).toThrow('Preview Cloud identity configuration is invalid');
  });

  it.each([
    ['unknown prefix', CLOUD_ENV, { prefix: 'unit', userId: DESKTOP_ID }],
    [
      'invalid run ID',
      { ...CLOUD_ENV, E2E_PREVIEW_RUN_ID: 'invalid' },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    [
      'missing mobile ID',
      { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: '' },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    [
      'missing desktop ID',
      { ...CLOUD_ENV, E2E_PREVIEW_DESKTOP_USER_ID: '' },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    [
      'invalid desktop ID',
      { ...CLOUD_ENV, E2E_PREVIEW_DESKTOP_USER_ID: 'invalid' },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    [
      'invalid mobile ID',
      { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: 'invalid' },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    [
      'identical IDs',
      { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: DESKTOP_ID },
      { prefix: 'critical-path', userId: DESKTOP_ID },
    ],
    ['seed or mismatched user ID', CLOUD_ENV, { prefix: 'critical-path', userId: SEED_ID }],
  ])('rejects %s before calling Auth createUser', async (_reason, env, identityInput) => {
    for (const key of Object.keys(CLOUD_ENV)) {
      vi.stubEnv(key, env[key as keyof typeof env] ?? '');
    }
    const createUser = vi.fn();
    const admin = { auth: { admin: { createUser } } } as never;
    const identity = {
      ...identityInput,
      email: 'private@example.com',
      password: 'private-password',
      activityName: 'Private activity',
      categoryName: 'Private category',
    };

    await expect(seedCriticalPathUser(admin, identity, 'synthetic fixture')).rejects.toThrow(
      'Preview Cloud identity configuration is invalid',
    );
    expect(createUser).not.toHaveBeenCalled();
  });

  it('does not leak configured IDs through validation errors', () => {
    const invalidEnv = { ...CLOUD_ENV, E2E_PREVIEW_MOBILE_USER_ID: DESKTOP_ID };
    try {
      resolvePreviewCloudUserId('critical-path', invalidEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(DESKTOP_ID);
      expect((error as Error).message).not.toContain(MOBILE_ID);
    }
  });
});
