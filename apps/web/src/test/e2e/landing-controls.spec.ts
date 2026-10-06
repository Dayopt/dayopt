import { expect, test } from '@playwright/test';

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} login controls navigate to the matching Product login @mobile`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    const signupHref = await page
      .locator('header a[href$="/auth/signup"]')
      .first()
      .getAttribute('href');
    const destination = new URL('/auth/login', signupHref!).href;
    let requests = 0;
    await page.route(destination, async (route) => {
      requests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>Intercepted Product login</h1>',
      });
    });
    await page
      .locator('header a')
      .filter({ hasText: locale ? 'ログイン' : 'Login' })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(destination);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Intercepted Product login');
    expect(requests).toBe(1);
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.goto(locale || '/');
      await page.locator('header button').last().click();
      await page
        .getByRole('dialog')
        .getByRole('link', { name: /ログイン|Login/ })
        .click();
      await expect(page).toHaveURL(destination);
      expect(requests).toBe(2);
    }
  });

  test(`${locale || 'en'} replay controls restart the hero and closing motions`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    await page.locator('aside').getByRole('button').first().click();
    const journey = page.locator('section').first().getByRole('group');
    const before = await journey.locator(':scope > div').first().elementHandle();
    await journey.getByRole('button').click();
    expect(await before!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(journey.locator('svg')).toBeVisible();
    const closing = page.locator('#next-day button');
    const previousMark = await closing.locator(':scope > span').elementHandle();
    await closing.click();
    expect(await previousMark!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(closing.locator(':scope > span')).toBeVisible();
  });
}
