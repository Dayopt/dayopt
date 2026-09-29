import { expect, type Page } from '@playwright/test';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import {
  type AdminSupabase,
  cleanupCriticalPathUser,
  createAdminSupabase,
  createCriticalPathIdentity,
  loginAs,
  seedCriticalPathUser,
  TIMEZONE,
} from './critical-path-fixture';
import { test } from './preview-access-fixture';

const target = resolveServiceRoleTarget(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);
assertServiceRoleSuiteRunnable(target, 'Preview: user authorization');
const describeWithEnv = target.safe ? test.describe : test.describe.skip;

type OwnedRow = { id: string; title: string; note: string; updatedAt: string };

/** Normal browser credentials stay inside the page; raw server responses are never evidence. */
async function command(page: Page, procedure: string, input: Record<string, unknown>) {
  return page.evaluate(
    async ({ procedure, input }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = localStorage.getItem('auth_token');
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`/api/trpc/${procedure}?batch=1`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ 0: { json: input } }),
      });
      const envelopes = await response.json();
      const envelope = Array.isArray(envelopes) && envelopes.length === 1 ? envelopes[0] : null;
      const data = envelope?.result?.data?.json;
      const error = envelope?.error?.json?.data;
      // Return only fields required for the owned synthetic row checks.
      return {
        status: response.status,
        code: ['NOT_FOUND', 'FORBIDDEN', 'CONFLICT'].includes(error?.code) ? error.code : null,
        serviceCode: error?.serviceCode === 'STALE_TARGET' ? 'STALE_TARGET' : null,
        row:
          data && typeof data.id === 'string' && typeof data.updated_at === 'string'
            ? { id: data.id, title: data.title, note: data.note, updatedAt: data.updated_at }
            : null,
      };
    },
    { procedure, input },
  );
}

async function createOwned(page: Page, kind: 'plan' | 'record', title: string): Promise<OwnedRow> {
  const start = new Date(Date.now() + (kind === 'plan' ? 1 : -1) * 86_400_000);
  const result = await command(page, `${kind}Commands.create`, {
    title,
    note: title,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 3_600_000).toISOString(),
  });
  expect(result.status).toBe(200);
  expect(result.row?.id).toMatch(/^[a-f0-9-]{36}$/i);
  expect(result.row?.title).toBe(title);
  expect(result.row?.note).toBe(title);
  expect(Number.isFinite(Date.parse(result.row?.updatedAt ?? ''))).toBe(true);
  if (!result.row) throw new Error('Owned synthetic row was not created');
  return result.row;
}

async function expectOwned(page: Page, kind: 'plan' | 'record', row: OwnedRow) {
  const result = await command(page, `${kind}s.getById`, { id: row.id });
  expect(result.status).toBe(200);
  expect(result.row).toEqual(row);
}

async function expectForeignDenied(page: Page, kind: 'plan' | 'record', row: OwnedRow) {
  for (const action of ['read', 'update', 'delete'] as const) {
    await test.step(`foreign ${kind} ${action} denied`, async () => {
      const procedure = action === 'read' ? `${kind}s.getById` : `${kind}Commands.${action}`;
      const input =
        action === 'read'
          ? { id: row.id }
          : {
              id: row.id,
              expectedUpdatedAt: row.updatedAt,
              ...(action === 'update'
                ? { data: { note: 'foreign mutation must be rejected' } }
                : {}),
            };
      const result = await command(page, procedure, input);
      expect(result.row).toBeNull();
      // Versioned delete hides a missing/foreign target as STALE_TARGET; a generic
      // conflict, malformed input, failed login, or billing rejection cannot pass.
      if (action === 'delete' && result.code === 'CONFLICT') {
        expect(result.status).toBe(409);
        expect(result.serviceCode).toBe('STALE_TARGET');
      } else {
        expect(['NOT_FOUND', 'FORBIDDEN']).toContain(result.code);
        expect([403, 404]).toContain(result.status);
      }
    });
  }
}

describeWithEnv('Preview: user authorization', () => {
  test.use({ timezoneId: TIMEZONE });
  const a = createCriticalPathIdentity('critical-path');
  const b = createCriticalPathIdentity('mobile-critical-path');
  let admin: AdminSupabase;

  test.beforeAll(async () => {
    admin = createAdminSupabase(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
    );
    await seedCriticalPathUser(admin, a, 'authorization A');
    await seedCriticalPathUser(admin, b, 'authorization B');
  });
  test.afterAll(async () => {
    if (!admin) return;
    const cleanup = await Promise.allSettled(
      [a, b].map((identity) => cleanupCriticalPathUser(admin, identity.userId)),
    );
    if (cleanup.some((result) => result.status === 'rejected'))
      throw new Error('Authorization fixture cleanup failed');
  });

  test('A/B cannot read, update or delete each other’s Plan and Record', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    async function login(identity: typeof a) {
      if (page.url().startsWith('http')) {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      }
      await context.clearCookies();
      await loginAs(page, identity);
    }
    await login(a);
    const aPlan = await createOwned(page, 'plan', a.activityName);
    const aRecord = await createOwned(page, 'record', a.activityName);
    await expectOwned(page, 'plan', aPlan);
    await expectOwned(page, 'record', aRecord);

    await login(b);
    await expectForeignDenied(page, 'plan', aPlan);
    await expectForeignDenied(page, 'record', aRecord);
    const bPlan = await createOwned(page, 'plan', b.activityName);
    const bRecord = await createOwned(page, 'record', b.activityName);

    await login(a);
    await expectOwned(page, 'plan', aPlan);
    await expectOwned(page, 'record', aRecord);
    await expectForeignDenied(page, 'plan', bPlan);
    await expectForeignDenied(page, 'record', bRecord);

    await login(b);
    await expectOwned(page, 'plan', bPlan);
    await expectOwned(page, 'record', bRecord);
  });
});
