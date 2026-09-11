import { expect, test, type Page } from '@playwright/test';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from '../create-scoped-test-user';
import { suppressConsentBanner } from '../suppress-consent-banner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// service role で auth user / profile を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'PWA Service Worker');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

async function getRegisteredServiceWorker(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return null;
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations[0]?.scope ?? null;
  });
}

/**
 * offline fallback を返せる状態か。**登録の存在では足りない**（#2654）。
 *
 * `getRegistrations()` は worker が `installing` の間も registration を返すので、
 * それだけを待って offline へ落とすと、precache 途中の worker がまだ page を
 * 制御しないまま reload が走り、SW を通らない navigation がブラウザのネットワーク
 * エラー画面（`<body></body>`）になる。待つべき状態を 2 つとも名指しする:
 *
 * 1. `navigator.serviceWorker.controller` が非 null — sw.js の activate が
 *    `clients.claim()` を呼ぶので、これは「activate 済みかつこの page を制御中」の合図
 * 2. `/offline` が cache にある — install の precache は best-effort で個別の失敗を
 *    握るため、install 完了だけでは precache 済みを意味しない
 *
 * `navigator.serviceWorker.ready` は解決するまで返らず poll の timeout が効かないので使わない。
 */
async function isOfflineFallbackReady(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    if (!navigator.serviceWorker.controller) return false;
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      if (await cache.match('/offline')) return true;
    }
    return false;
  });
}

/** reload 後の document を Service Worker が制御しているか（= ブラウザのエラー画面ではない）。 */
async function isControlledByServiceWorker(page: Page): Promise<boolean> {
  return page.evaluate(
    () => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
  );
}

test.describe('PWA installability', () => {
  test('exposes a valid web app manifest', async ({ page }) => {
    await page.goto('/');

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();

    const manifestUrl = new URL(manifestHref!, page.url());
    const response = await page.request.get(manifestUrl.toString());
    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('start_url');
    expect(manifest).toHaveProperty('display');
    expect(manifest).toHaveProperty('icons');

    const icons = manifest['icons'] as Array<Record<string, unknown>>;
    const sizes = icons.map((icon) => icon['sizes'] as string);
    expect(sizes.some((size) => size.includes('192'))).toBe(true);
    expect(sizes.some((size) => size.includes('512'))).toBe(true);
  });
});

/**
 * Service Worker の登録とオフライン fallback。
 *
 * **この 2 本には認証が要る。** `ServiceWorkerProvider` は `(app)` group の
 * `ProvidersComposition` にしか mount されていない。`/` は `[locale]/page.tsx` で
 * `/{locale}/calendar` へ redirect し、そこは `access-policy.ts` の
 * `protectedProductPaths` なので未認証だと `(auth)` group のログイン画面へ飛ぶ。
 * ログイン画面の `PublicProviders` は SW を登録しないため、未認証のまま
 * `getRegistrations()` を待っても永久に空になる（#2647 のセルフレビューで実測）。
 *
 * **CI でだけ走る。** SW は `useServiceWorker` が `NODE_ENV === 'development'` で
 * 登録を止めるので、dev server では登録されない。production build を起動するのは
 * `playwright.config.ts` の webServer（`process.env.CI` で分岐）なので同じ判定を使う。
 * 以前は runner 側の `NODE_ENV` を見ており、CI でも常に真＝永久 skip だった。
 */
describeWithEnv('PWA Service Worker', () => {
  test.skip(
    !process.env.CI,
    'Service Worker は CI の production build（pnpm start）でのみ登録される',
  );

  let testUser: ScopedTestUser | undefined;

  test.beforeAll(async () => {
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'pwa');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  /** ログインして `(app)` group（= SW を登録する層）まで入る。 */
  async function loginToApp(page: Page) {
    await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"], input[name="email"]').first().fill(testUser!.email);
    await page.locator('input[type="password"]').first().fill(testUser!.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
  }

  test('registers the service worker in a production build', async ({ page }) => {
    await loginToApp(page);

    // ServiceWorkerProvider は dynamic import なので、chunk の取得と useEffect の
    // 発火ぶんの余裕を見る（登録自体は navigator.serviceWorker.register の 1 往復）。
    await expect.poll(() => getRegisteredServiceWorker(page), { timeout: 15_000 }).not.toBeNull();
  });

  test('serves cached content or the offline fallback without a network', async ({
    context,
    page,
  }) => {
    await loginToApp(page);
    // 登録の存在ではなく「activate 済みで page を制御」「/offline が precache 済み」を待つ。
    await expect.poll(() => isOfflineFallbackReady(page), { timeout: 15_000 }).toBe(true);

    await context.setOffline(true);
    // sw.js は navigation を DYNAMIC cache → network → `/offline` の順で解決する。
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);

    // 描画されたのが cache 済みページでも `/offline` でも、SW が返した document である
    // ことは共通する。body の非空だけだとブラウザのエラー画面でも通ってしまう。
    await expect.poll(() => isControlledByServiceWorker(page), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('body')).not.toBeEmpty();
    await context.setOffline(false);
  });
});
