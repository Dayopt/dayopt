import { BROWSER_TELEMETRY_CONSENT_STORAGE_KEY } from '@dayopt/observability';
import { expect, type Page, test } from '@playwright/test';

import commonEn from '../../../messages/en/common.json' with { type: 'json' };

/**
 * 分析同意の撤回導線 E2E（#2831）
 *
 * 「一度選んだ利用者が、localStorage を手で消さずに選び直せる」ことを実ブラウザで固定する。
 * 撤回を受け取る側（BrowserTelemetry / instrumentation-client）の unit test は
 * 同意イベントを直接投げるので、**バナーと footer の導線が実際に同意値を書き換え、
 * それが reload と別タブへ伝わるか**はこの層でしか見えない。
 *
 * Vercel SDK は Production 限定。PostHog は別の送信スイッチと project key がある時だけ
 * 読み込む。この E2E は同意の保存と伝播を検証し、実送信は別途確認する。
 */

const banner = commonEn.common.cookies.banner;
const settings = commonEn.common.cookies.settings;

async function readStoredConsent(page: Page) {
  const raw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
  );
  return raw === null ? null : (JSON.parse(raw) as { analytics: boolean; marketing: boolean });
}

test('footer の Cookie 設定から、保存済みの分析同意を撤回・再許可できる', async ({
  page,
  context,
}) => {
  await page.goto('/');

  // 1. 初回バナーで拒否する（バナーは requestIdleCallback 後に出る）
  await page.getByRole('button', { name: banner.necessaryOnly }).click();
  expect(await readStoredConsent(page)).toMatchObject({ analytics: false, marketing: false });

  // 2. 常設導線から許可し直す（撤回前の「再許可できる」側）
  await page.getByRole('button', { name: settings.trigger }).click();
  await expect(page.getByText(settings.status.refused, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: banner.allowAnalytics }).click();
  expect(await readStoredConsent(page)).toMatchObject({ analytics: true, marketing: false });

  // 3. 再訪しても選択が残り、初回バナーは出ない
  await page.reload();
  // バナーは idle callback（timeout 2000ms）後に判定されるので、その窓を過ぎてから断定する。
  await page.waitForTimeout(2500);
  await expect(page.getByRole('button', { name: banner.necessaryOnly })).toHaveCount(0);

  // 4. 別タブが現在の選択を見ている状態を作る
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await otherTab.getByRole('button', { name: settings.trigger }).click();
  await expect(otherTab.getByText(settings.status.allowed, { exact: false })).toBeVisible();

  // 5. 元タブで撤回する。許可済みからの撤回は再読み込みを伴うので確認を挟む
  await page.getByRole('button', { name: settings.trigger }).click();
  await page.getByRole('button', { name: banner.necessaryOnly }).click();
  await expect(page.getByText(settings.revokeConfirmDescription)).toBeVisible();
  // 確認前に保存してしまっていないこと
  expect(await readStoredConsent(page)).toMatchObject({ analytics: true });
  await page.getByRole('button', { name: settings.revokeConfirmLabel }).click();
  expect(await readStoredConsent(page)).toMatchObject({ analytics: false });
  await expect(otherTab.getByText(settings.status.refused, { exact: false })).toBeVisible();

  await otherTab.close();
});
