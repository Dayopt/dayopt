import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertAccountDeletionUserSafe,
  cleanupAccountDeletionUser,
  confirmAccountDeletionUserAbsent,
  createAccountDeletionIdentity,
  seedAccountDeletionUser,
  type AccountDeletionIdentity,
} from './e2e/account-deletion-fixture';

const RUN = '11111111-1111-4111-8111-111111111111';
const DELETION = '44444444-4444-4444-8444-444444444444';
let directory: string;
let identity: AccountDeletionIdentity;

function mockAdmin() {
  let current: ReturnType<typeof authUser> | null = null;
  const counts = new Map<string, number>();
  let profile = { stripe_customer_id: null as string | null, subscription_status: 'free' };
  const getUserById = vi.fn(async () =>
    current
      ? { data: { user: current }, error: null }
      : { data: { user: null }, error: { status: 404, code: 'user_not_found' } },
  );
  const createUser = vi.fn(async () => {
    expect(journal().status).toBe('creating');
    current = authUser();
    return { data: { user: current }, error: null as { message: string } | null };
  });
  const deleteUser = vi.fn(async () => {
    current = null;
    return { error: null };
  });
  const from = vi.fn((table: string) => ({
    upsert: vi.fn(async () => ({ error: null })),
    select: vi.fn(() => ({
      eq: vi.fn((_column: string, id: string) => {
        expect(id).toBe(DELETION);
        return table === 'profiles'
          ? { single: async () => ({ data: profile, error: null }) }
          : Promise.resolve({ count: counts.get(table) ?? 0, error: null });
      }),
    })),
  }));
  return {
    auth: { admin: { getUserById, createUser, deleteUser } },
    from,
    counts,
    setUser: (user: ReturnType<typeof authUser> | null) => {
      current = user;
    },
    setProfile: (value: typeof profile) => {
      profile = value;
    },
  };
}

function authUser() {
  return {
    id: identity.userId,
    email: identity.email,
    app_metadata: { e2e_run_id: identity.runId, providers: ['email'] },
    identities: [{ provider: 'email' }],
  };
}

function journal() {
  return JSON.parse(readFileSync(join(directory, 'users', `${DELETION}.json`), 'utf8'));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'preview-account-deletion-'));
  for (const [key, value] of Object.entries({
    E2E_PREVIEW_CLOUD_INTENT: '1',
    E2E_PREVIEW_RUN_ID: RUN,
    E2E_PREVIEW_DESKTOP_USER_ID: '22222222-2222-4222-8222-222222222222',
    E2E_PREVIEW_MOBILE_USER_ID: '33333333-3333-4333-8333-333333333333',
    E2E_PREVIEW_DELETION_USER_ID: DELETION,
    E2E_PREVIEW_EVIDENCE_DIR: directory,
  }))
    vi.stubEnv(key, value);
  identity = createAccountDeletionIdentity();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('dedicated disposable account deletion fixture', () => {
  it('creates exactly the third ID with a durable run marker and records verified UI deletion', async () => {
    const admin = mockAdmin();
    await seedAccountDeletionUser(admin as never, identity);
    expect(identity.userId).toBe(DELETION);
    expect(admin.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DELETION,
        app_metadata: { e2e_run_id: RUN },
        email_confirm: true,
      }),
    );
    expect(journal()).toMatchObject({ runId: RUN, userId: DELETION, status: 'created' });
    admin.setUser(null); // The UI deletion has removed the Auth user.
    await confirmAccountDeletionUserAbsent(admin as never, identity);
    expect(journal().status).toBe('deleted');
    await cleanupAccountDeletionUser(admin as never, identity);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('never adopts a pre-existing user even with a matching run marker', async () => {
    const admin = mockAdmin();
    admin.setUser(authUser());
    await expect(seedAccountDeletionUser(admin as never, identity)).rejects.toThrow(
      'already present',
    );
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
    await cleanupAccountDeletionUser(admin as never, identity);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it.each(['collision error', 'wrong returned ID', 'wrong returned marker'])(
    'does not own creation after %s',
    async (scenario) => {
      const admin = mockAdmin();
      admin.auth.admin.createUser.mockImplementationOnce(async () => {
        const user = authUser();
        if (scenario === 'wrong returned ID') user.id = '55555555-5555-4555-8555-555555555555';
        if (scenario === 'wrong returned marker')
          user.app_metadata.e2e_run_id = '66666666-6666-4666-8666-666666666666';
        admin.setUser(user);
        return {
          data: { user },
          error: scenario === 'collision error' ? { message: 'already exists' } : null,
        };
      });
      await expect(seedAccountDeletionUser(admin as never, identity)).rejects.toThrow(
        'synthetic creation failed',
      );
      await cleanupAccountDeletionUser(admin as never, identity);
      expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
      expect(admin.from).not.toHaveBeenCalled();
      expect(journal().status).toBe('creation-unconfirmed');
    },
  );

  it('rechecks current ownership before any fallback Auth deletion', async () => {
    const admin = mockAdmin();
    await seedAccountDeletionUser(admin as never, identity);
    const replacement = authUser();
    replacement.app_metadata.e2e_run_id = '66666666-6666-4666-8666-666666666666';
    admin.setUser(replacement);
    await expect(cleanupAccountDeletionUser(admin as never, identity)).rejects.toThrow(
      'owned cleanup failed',
    );
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(journal().status).toBe('cleanup-failed');
  });

  it('cleans only a created user still owned by this run, then positively verifies absence', async () => {
    const admin = mockAdmin();
    await seedAccountDeletionUser(admin as never, identity);
    await cleanupAccountDeletionUser(admin as never, identity);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledExactlyOnceWith(DELETION);
    expect(journal().status).toBe('deleted');
  });

  it.each([
    'Stripe customer',
    'paid status',
    'Google identity',
    'calendar_connections',
    'oauth_connections',
    'oauth_tokens',
    'oauth_authorization_codes',
  ])('blocks destructive UI when %s is present', async (scenario) => {
    const admin = mockAdmin();
    await seedAccountDeletionUser(admin as never, identity);
    if (scenario === 'Stripe customer')
      admin.setProfile({ stripe_customer_id: 'cus_synthetic', subscription_status: 'free' });
    else if (scenario === 'paid status')
      admin.setProfile({ stripe_customer_id: null, subscription_status: 'active' });
    else if (scenario === 'Google identity') {
      const user = authUser();
      user.identities.push({ provider: 'google' });
      admin.setUser(user);
    } else admin.counts.set(scenario, 1);
    await expect(assertAccountDeletionUserSafe(admin as never, identity)).rejects.toThrow();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does not treat an Auth read failure as deletion success', async () => {
    const admin = mockAdmin();
    await seedAccountDeletionUser(admin as never, identity);
    admin.auth.admin.getUserById.mockRejectedValueOnce(new Error('private-provider-error'));
    await expect(confirmAccountDeletionUserAbsent(admin as never, identity)).rejects.toThrow(
      'Auth readback failed',
    );
    expect(journal().status).toBe('created');
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
