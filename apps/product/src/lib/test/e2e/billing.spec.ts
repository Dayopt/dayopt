import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { AppRouter } from '@/lib/trpc/root';
import type { inferRouterOutputs } from '@trpc/server';

import type { Database } from '@/lib/database';
import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { suppressConsentBanner } from './suppress-consent-banner';
import {
  fulfillTrpcProcedure,
  fulfillTrpcResponse,
  trpcProcedureRoutePattern,
} from './trpc-response-mock';

/**
 * Billing E2E — Checkout / Customer Portal への遷移導線と、Stripe Checkout からの
 * 復帰導線（`?success=true` / `?canceled=true`）を検証する。
 *
 * 復帰先は `/settings/billing`（#1881 で `/settings/subscription` から変更。旧 URL は
 * 有効な設定カテゴリでないため白紙になっていた）。`settings/[category]/page.tsx` が
 * 復帰 query を検出して toast 表示 + `billing.getOverview` invalidate を行い、desktop
 * は SettingsDialog を再度開いて `/` へ replace、mobile は query を除いた
 * `/settings/billing` へ replace する。
 *
 * Stripe 自体は叩かない。`billing.createCheckoutSession` / `billing.createPortalSession`
 * の tRPC レスポンスを `page.route` で intercept し、client が実際に
 * `window.location.href` で Stripe のホスト（checkout.stripe.com /
 * billing.stripe.com）へ遷移しようとすることだけを確認する
 * （`BillingSettings.tsx` の `onSuccess` 参照）。Stripe 側の遷移リクエストは
 * `route.abort()` してテスト実行を Stripe に依存させない。
 *
 * seed は service role で自前ユーザーを作る（critical-path.spec.ts と同型）。
 * 実行先は resolveServiceRoleTarget が安全と判定した時だけ有効になる。
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CheckoutSessionResponse = RouterOutputs['billing']['createCheckoutSession'];
type PortalSessionResponse = RouterOutputs['billing']['createPortalSession'];
type BillingOverviewResponse = RouterOutputs['billing']['getOverview'];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
// service role で auth user / profile を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Billing: Checkout / Portal 導線');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `billing-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';

const DUMMY_CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/e2e-dummy';
const DUMMY_PORTAL_URL = 'https://billing.stripe.com/p/session/e2e-dummy';

// 両方 toast.success のため type では区別できない。文言で区別する
// （messages/ja/settings.json の settings.subscription.checkoutSuccess / checkoutCanceled と同期）。
const CHECKOUT_SUCCESS_TOAST_TEXT =
  '契約が有効になりました。Dayoptをご利用いただきありがとうございます。';
const CHECKOUT_CANCELED_TOAST_TEXT =
  'チェックアウトがキャンセルされました。いつでもアップグレードできます。';

type SupabaseClient = ReturnType<typeof createClient<Database>>;

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
}

/**
 * 設定 > 課金カテゴリへ遷移する。
 *
 * desktop は `/settings/[category]/page.tsx` が `openSettings(category)` +
 * `router.replace(DESKTOP_SETTINGS_EXIT_PATH)` するため、workspace へ戻った上で SettingsDialog が開く
 * （GlobalOverlays.tsx に常駐）。mobile はページ遷移のまま留まる。
 */
async function openBillingSettings(page: Page) {
  await page.goto('/ja/settings/billing');
}

describeWithEnv('Billing: Checkout / Portal 導線', () => {
  test.describe.configure({ mode: 'serial' });

  let adminSupabase: SupabaseClient;

  test.beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'billing e2e' },
    });
    // CI retries:2 + serial mode の再実行で "already exists" になりうるため許容する
    if (authError && !authError.message.includes('already exists')) {
      throw new Error(authError.message);
    }

    // 既定は Free プラン（stripe_customer_id 無し、subscription_status は DB 側 default 'free'）
    const { error: profileError } = await adminSupabase.from('profiles').upsert({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (profileError) throw new Error(profileError.message);

    const { error: settingsError } = await adminSupabase.from('user_settings').upsert({
      user_id: TEST_USER_ID,
      timezone: 'Asia/Tokyo',
      preferred_locale: 'ja',
      default_view: 'day',
      default_duration: 60,
      time_format: '24h',
      week_starts_on: 1,
    });
    if (settingsError) throw new Error(settingsError.message);
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;

    // PostgREST の DELETE は 0 行一致でも 204 を返すため、対象が既に無いことは
    // error にならない。error が立つのは実際の失敗だけなので、そのまま記録する。
    const { error: settingsError } = await adminSupabase
      .from('user_settings')
      .delete()
      .eq('user_id', TEST_USER_ID);
    if (settingsError) {
      console.error('[billing.spec] user_settings cleanup failed', settingsError);
    }

    const { error: profileError } = await adminSupabase
      .from('profiles')
      .delete()
      .eq('id', TEST_USER_ID);
    if (profileError) {
      console.error('[billing.spec] profiles cleanup failed', profileError);
    }

    const { error: authDeleteError } = await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
    // ユーザーが既に存在しない場合も成功扱い（冪等な cleanup）
    if (authDeleteError && !authDeleteError.message.toLowerCase().includes('not found')) {
      console.error('[billing.spec] auth user cleanup failed', authDeleteError);
    }
  });

  // login() は各 test が route 登録を終えてから呼ぶ。desktop shell の
  // useAppInlineBanner がログイン直後に billing.getOverview を取得し、
  // QueryClient の既定 staleTime（5 分）でキャッシュするため、後から route を
  // 登録すると BillingSettings がキャッシュを再利用して mock 対象のリクエストを
  // 送らない。
  const MOBILE_SKIP_REASON = 'desktop-only（Stripe host route intercept と SettingsDialog 前提）';

  test('アップグレード操作で Stripe Checkout へ遷移しようとする', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), MOBILE_SKIP_REASON);
    test.skip(
      !process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID,
      'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID 未設定（未設定だとアップグレードボタンが disabled のまま）',
    );

    await page.route('**/api/trpc/billing.createCheckoutSession*', (route) =>
      fulfillTrpcResponse<CheckoutSessionResponse>(route, { url: DUMMY_CHECKOUT_URL }),
    );
    // Stripe 自体は叩かない。遷移が試みられたことだけを確認して即 abort する
    await page.route('https://checkout.stripe.com/**', (route) => route.abort());

    await login(page);
    await openBillingSettings(page);

    const upgradeButton = page.getByRole('button', { name: '月 $5 で利用する' });
    await expect(upgradeButton).toBeVisible({ timeout: 10_000 });
    await expect(upgradeButton).toBeEnabled();

    const stripeRequestPromise = page.waitForRequest((request) =>
      request.url().startsWith('https://checkout.stripe.com/'),
    );

    await upgradeButton.click();

    const stripeRequest = await stripeRequestPromise;
    expect(stripeRequest.url()).toBe(DUMMY_CHECKOUT_URL);
  });

  test('プラン調整操作で Stripe Customer Portal へ遷移しようとする', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), MOBILE_SKIP_REASON);
    // "プランを調整" ボタンは canAccessPro 限定なので、Pro ユーザーの overview を返す。
    //
    // profiles.stripe_customer_id を実 DB に upsert する案は採れない。getBillingOverview は
    // stripeCustomerId が非 null だと requireStripe() 経由で実 Stripe を呼ぶため
    // （billing-service.ts:363-374）、STRIPE_SECRET_KEY を渡さないローカル / CI では
    // billing.getOverview が INTERNAL_SERVER_ERROR になり画面が ErrorState に落ちる。
    // read 側も mock して Stripe には一切到達させない。
    //
    // 登録に trpcProcedureRoutePattern を使うのは、userSettings.get の prefetch と同一 tick で
    // batch されると URL が `billing.getOverview` 単体でなくなるため（同ファイルの doc 参照）。
    await page.route(trpcProcedureRoutePattern('billing.getOverview'), (route) =>
      fulfillTrpcProcedure<BillingOverviewResponse>(route, 'billing.getOverview', {
        billingInfo: {
          subscriptionStatus: 'active',
          stripeCustomerId: 'cus_e2e_dummy',
          subscriptionId: null,
        },
        paymentMethod: null,
        invoices: [],
        trialEndsAt: null,
        access: {
          state: 'subscribed' as const,
          canUseProduct: true,
          trialEndsAt: null,
          enforced: false,
        },
      }),
    );
    await page.route('**/api/trpc/billing.createPortalSession*', (route) =>
      fulfillTrpcResponse<PortalSessionResponse>(route, { url: DUMMY_PORTAL_URL }),
    );
    // Stripe 自体は叩かない。遷移が試みられたことだけを確認して即 abort する
    await page.route('https://billing.stripe.com/**', (route) => route.abort());

    await login(page);
    await openBillingSettings(page);

    const adjustPlanButton = page.getByRole('button', { name: 'プランを調整' });
    await expect(adjustPlanButton).toBeVisible({ timeout: 10_000 });
    await expect(adjustPlanButton).toBeEnabled();

    const stripeRequestPromise = page.waitForRequest((request) =>
      request.url().startsWith('https://billing.stripe.com/'),
    );

    await adjustPlanButton.click();

    const stripeRequest = await stripeRequestPromise;
    expect(stripeRequest.url()).toBe(DUMMY_PORTAL_URL);
  });

  // Checkout からの復帰導線（#1881）。Stripe は経由しないため mock 不要。
  // settings/[category]/page.tsx が `?success=true` / `?canceled=true` を検出して
  // toast を出すことだけを確認する。PC は openSettings + workspace への replace が
  // 続くが、遷移先が (app) 内に留まるので Toaster は unmount されず toast は残る。
  test('Checkout 成功復帰（?success=true）で成功 toast が表示される', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), MOBILE_SKIP_REASON);

    await login(page);
    await page.goto('/ja/settings/billing?success=true');

    await expect(page.getByText(CHECKOUT_SUCCESS_TOAST_TEXT)).toBeVisible({ timeout: 10_000 });
  });

  test('Checkout キャンセル復帰（?canceled=true）でキャンセル toast が表示される', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), MOBILE_SKIP_REASON);

    await login(page);
    await page.goto('/ja/settings/billing?canceled=true');

    await expect(page.getByText(CHECKOUT_CANCELED_TOAST_TEXT)).toBeVisible({ timeout: 10_000 });
  });

  // Portal からの復帰（?portal_return=true）は課金概要の invalidate だけが目的で、
  // 通知するイベントではないので toast を出さない。invalidate 自体は
  // settings/__tests__/routing.test.tsx が assert する。ここでは Checkout の
  // toast を巻き添えで出していないことと、白紙にならないことを確認する。
  test('Portal 復帰（?portal_return=true）では toast を出さず画面が壊れない', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), MOBILE_SKIP_REASON);

    await login(page);
    await page.goto('/ja/settings/billing?portal_return=true');

    await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(CHECKOUT_SUCCESS_TOAST_TEXT)).toBeHidden();
    await expect(page.getByText(CHECKOUT_CANCELED_TOAST_TEXT)).toBeHidden();
  });
});
