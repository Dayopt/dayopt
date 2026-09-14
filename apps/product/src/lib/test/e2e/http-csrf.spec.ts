import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { createScopedTestUser, type ScopedTestUser } from './create-scoped-test-user';
import { suppressConsentBanner } from './suppress-consent-banner';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const target = resolveServiceRoleTarget(url, key);
assertServiceRoleSuiteRunnable(target, 'HTTP CSRF boundary');
const describeWithEnv = target.safe ? test.describe : test.describe.skip;

describeWithEnv('authenticated browser HTTP mutation boundary', () => {
  let user: ScopedTestUser;
  let server: Server;
  let attackerOrigin: string;
  let admin: ReturnType<typeof createClient<Database>>;

  test.beforeAll(async () => {
    admin = createClient<Database>(url!, key!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    user = await createScopedTestUser(url!, key!, 'http-csrf');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Isolated origin fixture</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing isolated origin port');
    attackerOrigin = 'http://localhost:' + address.port;
  });

  test.afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (user) {
      const { error } = await admin.auth.admin.deleteUser(user.userId);
      if (error) throw new Error(error.message);
    }
  });

  test('same-origin write persists, cross-origin simple/JSON/GET requests cannot change it', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"]').first().fill(user.email);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
    const endpoint = new URL('/api/trpc/userSettings.update', baseURL).href;
    const write = (timeFormat: string) => JSON.stringify({ json: { timeFormat } });
    const initial = await page.evaluate(
      async ({ endpoint, body }) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        return response.status;
      },
      { endpoint, body: write('12h') },
    );
    expect(initial).toBe(200);
    const storedFormat = async () => {
      const { data, error } = await admin
        .from('user_settings')
        .select('time_format')
        .eq('user_id', user.userId)
        .single();
      if (error) throw new Error(error.message);
      return data.time_format;
    };
    expect(await storedFormat()).toBe('12h');

    // 同一hostnameの別portなのでSameSiteだけには頼らない境界を試す。
    await page.goto(attackerOrigin);
    const outcomes: string[] = [];
    for (const contentType of ['text/plain', 'application/json']) {
      outcomes.push(
        await page.evaluate(
          async ({ endpoint, body, contentType }) => {
            return fetch(endpoint, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': contentType },
              body,
            }).then(
              (response) => String(response.status),
              () => 'browser-blocked',
            );
          },
          { endpoint, body: write('24h'), contentType },
        ),
      );
      expect(await storedFormat()).toBe('12h');
    }
    const getEndpoint = endpoint + '?input=' + encodeURIComponent(write('24h'));
    outcomes.push(
      await page.evaluate(async (endpoint) => {
        return fetch(endpoint, { credentials: 'include' }).then(
          (response) => String(response.status),
          () => 'browser-blocked',
        );
      }, getEndpoint),
    );
    expect(await storedFormat()).toBe('12h');
    expect(outcomes).toEqual(['browser-blocked', 'browser-blocked', 'browser-blocked']);

    // 同じcookieが失効したから拒否された、という偽陽性を除く。
    await page.goto('/ja/calendar');
    const final = await page.evaluate(
      async ({ endpoint, body }) => {
        return (
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
        ).status;
      },
      { endpoint, body: write('24h') },
    );
    expect(final).toBe(200);
    expect(await storedFormat()).toBe('24h');

    // ビルド済みの実Action IDを使う。架空IDの拒否をCSRF成功と誤認しない。
    const manifestPath = process.env.CI
      ? '.next/server/server-reference-manifest.json'
      : '.next/dev/server/server-reference-manifest.json';
    const manifest = z
      .object({
        node: z.record(z.object({ exportedName: z.string().optional() })),
      })
      .parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    const actionId = Object.entries(manifest.node).find(
      ([, action]) => action.exportedName === 'generateAndSaveRecoveryCodesAction',
    )?.[0];
    expect(actionId, '実際に配信されるServer Actionが存在すること').toBeTruthy();
    const actionUrl = new URL('/ja/calendar', baseURL).href;
    const sameOriginAction = await page.evaluate(
      async ({ actionId, actionUrl }) => {
        const form = new FormData();
        form.set('$ACTION_ID_' + actionId, '');
        return (await fetch(actionUrl, { method: 'POST', body: form })).status;
      },
      { actionId: actionId!, actionUrl },
    );
    expect(sameOriginAction).toBe(200);

    await page.goto(attackerOrigin);
    const rejectedAction = page.waitForResponse(
      (response) => response.url() === actionUrl && response.request().method() === 'POST',
    );
    await page.evaluate(
      ({ actionId, actionUrl }) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.enctype = 'multipart/form-data';
        form.action = actionUrl;
        const input = document.createElement('input');
        input.name = '$ACTION_ID_' + actionId;
        form.append(input);
        document.body.append(form);
        form.submit();
      },
      { actionId: actionId!, actionUrl },
    );
    const actionResponse = await rejectedAction;
    expect(actionResponse.status()).toBe(500);
    expect((await actionResponse.request().allHeaders()).origin).toBe(attackerOrigin);
  });
});
