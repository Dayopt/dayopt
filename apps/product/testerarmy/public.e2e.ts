import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

for (const locale of ['en', 'ja']) {
  const prefix = locale === 'ja' ? '/ja' : '';
  test(`${locale}: signup navigation preserves locale`, async ({ app, browser }) => {
    await app.open(`${prefix}/auth/login`);
    await expect(browser.locator('input[type="email"]')).toBeVisible();
    await browser.locator(`a[href="${prefix}/auth/signup"]`).tap();
    await expect(browser).toHaveURL(new RegExp(`${prefix}/auth/signup/?$`));
    await expect(browser.locator('input[type="password"]').first()).toBeVisible();
  });

  test(`${locale}: password reset navigation returns to login`, async ({ app, browser }) => {
    await app.open(`${prefix}/auth/login`);
    await browser.locator(`a[href="${prefix}/auth/password"]`).tap();
    await expect(browser).toHaveURL(new RegExp(`${prefix}/auth/password/?$`));
    await expect(browser.locator('input[type="email"]')).toBeVisible();
    await browser.locator(`a[href="${prefix}/auth/login"]`).tap();
    await expect(browser).toHaveURL(new RegExp(`${prefix}/auth/login/?$`));
    await expect(browser.locator('input[type="password"]')).toBeVisible();
  });

  for (const route of [
    '/calendar',
    '/report',
    '/settings',
    '/settings/account',
    '/settings/display',
    '/settings/data',
    '/settings/integrations',
    '/settings/billing',
  ]) {
    test(`${locale}: signed-out ${route} redirects to login`, async ({ app, browser }) => {
      await app.open(`${prefix}${route}`);
      await expect(browser).toHaveURL(/\/auth\/login(?:\?|$)/);
      await expect(browser.locator('input[type="email"]')).toBeVisible();
      await expect(browser.locator('input[type="password"]')).toBeVisible();
    });
  }
}
