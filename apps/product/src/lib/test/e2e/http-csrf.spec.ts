import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

import { expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { resolveIsolatedServiceRoleTarget } from '../isolated-service-role-target';
import { cleanupIsolatedTestUser } from '../isolated-user-cleanup';
import { assertServiceRoleSuiteRunnable } from '../service-role-target-guard';
import { createScopedTestUser, type ScopedTestUser } from './create-scoped-test-user';
import { test } from './isolated-product-fixture';
import { suppressConsentBanner } from './suppress-consent-banner';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const target = resolveIsolatedServiceRoleTarget(url, key);
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
      await cleanupIsolatedTestUser(admin, url!, key!, user);
    }
  });

  test('same-origin write works; cross-origin simple/multipart/GET requests cannot change it', async ({
    page,
    request,
    baseURL,
    allowIsolatedOrigin,
  }) => {
    test.setTimeout(60_000);
    allowIsolatedOrigin(attackerOrigin);
    await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"]').first().fill(user.email);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/?(?:\?.*)?$/i, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    const authCookieNames = (await page.context().cookies(baseURL))
      .map(({ name }) => name)
      .filter((name) => /-auth-token(?:\.\d+)?$/.test(name));
    expect(authCookieNames.length).toBeGreaterThan(0);
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
    await page.waitForLoadState('networkidle');
    // Login hydration may still have a settings write in flight. Reset the disposable
    // user's sentinel after leaving Dayopt so it cannot race the attack.
    const reset = await admin
      .from('user_settings')
      .update({ time_format: '12h' })
      .eq('user_id', user.userId);
    expect(reset.error).toBeNull();
    expect(await storedFormat()).toBe('12h');

    for (const contentType of ['text/plain', 'multipart/form-data']) {
      const browserRequestPromise = page.waitForRequest(
        (browserRequest) =>
          new URL(browserRequest.url()).origin === new URL(endpoint).origin &&
          new URL(browserRequest.url()).pathname === new URL(endpoint).pathname &&
          browserRequest.method() === 'POST',
      );
      const outcome = await page.evaluate(
        async ({ endpoint, body, contentType }) => {
          const payload =
            contentType === 'multipart/form-data'
              ? (() => {
                  const form = new FormData();
                  form.set('input', body);
                  return form;
                })()
              : body;
          return fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            ...(contentType === 'text/plain' ? { headers: { 'content-type': contentType } } : {}),
            body: payload,
          }).then(
            (response) => String(response.status),
            () => 'browser-blocked',
          );
        },
        { endpoint, body: write('24h'), contentType },
      );
      const browserRequest = await browserRequestPromise;
      expect(outcome).toBe('browser-blocked');
      const browserHeaders = await browserRequest.allHeaders();
      const browserCookie = browserHeaders.cookie;
      expect(browserHeaders.origin).toBe(attackerOrigin);
      expect(
        authCookieNames.some((name) => browserCookie?.includes(`${name}=`)),
        '攻撃元からの要求にもログイン済みの Supabase Cookie が送られること',
      ).toBe(true);

      // CORS may hide the server's response from page.waitForResponse even when the
      // request reached the app. Verify the rejection directly with the same forged
      // Origin, session cookie, and payload so the guard's HTTP status is observable.
      const rejected = await request.post(endpoint, {
        headers: {
          origin: attackerOrigin,
          cookie: browserCookie ?? '',
          ...(contentType === 'text/plain' ? { 'content-type': contentType } : {}),
        },
        ...(contentType === 'multipart/form-data'
          ? { multipart: { input: write('24h') } }
          : { data: write('24h') }),
      });
      expect(rejected.status()).toBe(403);
      expect(await storedFormat()).toBe('12h');
    }
    const getEndpoint = endpoint + '?input=' + encodeURIComponent(write('24h'));
    const getBrowserRequestPromise = page.waitForRequest(
      (browserRequest) =>
        new URL(browserRequest.url()).origin === new URL(getEndpoint).origin &&
        new URL(browserRequest.url()).pathname === new URL(getEndpoint).pathname &&
        browserRequest.method() === 'GET',
    );
    const getOutcome = await page.evaluate(async (endpoint) => {
      return fetch(endpoint, { credentials: 'include' }).then(
        (response) => String(response.status),
        () => 'browser-blocked',
      );
    }, getEndpoint);
    const getBrowserRequest = await getBrowserRequestPromise;
    expect(await storedFormat()).toBe('12h');
    expect(getOutcome).toBe('browser-blocked');
    const getBrowserHeaders = await getBrowserRequest.allHeaders();
    expect(getBrowserHeaders.origin).toBe(attackerOrigin);
    expect(
      authCookieNames.some((name) => getBrowserHeaders.cookie?.includes(`${name}=`)),
      '攻撃元からのGETにもログイン済みのSupabase Cookieが送られること',
    ).toBe(true);
    const getResponse = await request.get(getEndpoint, {
      headers: { origin: attackerOrigin, cookie: getBrowserHeaders.cookie ?? '' },
    });
    expect(getResponse.status()).toBe(405);
    expect(await storedFormat()).toBe('12h');

    // 同じcookieが失効したから拒否された、という偽陽性を除く。
    await page.goto('/ja/');
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
    const actionUrl = new URL('/ja/', baseURL).href;
    const sameOriginAction = await page.evaluate(
      async ({ actionId, actionUrl }) => {
        const response = await fetch(actionUrl, {
          method: 'POST',
          headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: '[]',
        });
        return { status: response.status, text: await response.text() };
      },
      { actionId: actionId!, actionUrl },
    );
    expect(sameOriginAction.status).toBe(200);
    // This disposable user has no second factor: the real handler must reach
    // its AAL2 guard, not issue recovery credentials or merely render the page.
    expect(sameOriginAction.text).toContain('MFA verification is required to issue recovery codes');
    const recovery = await admin
      .from('mfa_recovery_codes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.userId);
    expect(recovery.error).toBeNull();
    expect(recovery.count).toBe(0);

    await page.goto(attackerOrigin);
    const actionBrowserRequestPromise = page.waitForRequest(
      (browserRequest) =>
        new URL(browserRequest.url()).origin === new URL(actionUrl).origin &&
        new URL(browserRequest.url()).pathname === new URL(actionUrl).pathname &&
        browserRequest.method() === 'POST',
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
    const actionBrowserRequest = await actionBrowserRequestPromise;
    const actionBrowserHeaders = await actionBrowserRequest.allHeaders();
    const actionBody = actionBrowserRequest.postDataBuffer();
    expect(actionBrowserHeaders.origin).toBe(attackerOrigin);
    expect(
      authCookieNames.some((name) => actionBrowserHeaders.cookie?.includes(`${name}=`)),
      'Server Actionを呼ぶ攻撃元フォームにもログイン済みのSupabase Cookieが送られること',
    ).toBe(true);
    expect(actionBody).not.toBeNull();

    // Capture the browser's actual Server Action submission, then replay its exact body
    // with the same session and forged Origin through APIRequestContext to observe the
    // deterministic Next.js rejection status.
    const actionResponse = await request.post(actionUrl, {
      headers: {
        origin: attackerOrigin,
        cookie: actionBrowserHeaders.cookie ?? '',
        'content-type': actionBrowserHeaders['content-type'] ?? '',
      },
      data: actionBody!,
    });
    expect(actionResponse.status()).toBe(500);
    const recoveryAfterAttack = await admin
      .from('mfa_recovery_codes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.userId);
    expect(recoveryAfterAttack.error).toBeNull();
    expect(recoveryAfterAttack.count).toBe(0);
  });
});
