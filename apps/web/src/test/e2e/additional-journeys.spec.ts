import { expect, test } from './public-test';

for (const locale of ['', '/ja']) {
  const ja = locale === '/ja';
  const target = ja ? '' : '/ja';

  test(`${locale || 'en'} language changes preserve search, pagination and anchor state`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    await page
      .locator('aside')
      .filter({ has: page.locator('#cookie-consent-title') })
      .getByRole('button')
      .first()
      .click();
    for (const path of ['/search?q=calendar', '/blog?page=2', '/docs/plans#main-content']) {
      await page.context().clearCookies();
      await page.goto(`${locale}${path}`);
      await page
        .getByRole('button', { name: `${ja ? '日本語' : 'English'} - Change language` })
        .click();
      const language = page.getByRole('menuitemcheckbox', { name: ja ? 'English' : '日本語' });
      await language.focus();
      await language.press('Enter');
      await expect(page).toHaveURL(`${new URL(page.url()).origin}${target}${path}`);
      if (path.startsWith('/search')) {
        await expect(page.locator('main input')).toHaveValue('calendar');
        await expect(page.locator(`main a[href^="${target}/docs/"]`).first()).toBeVisible();
      } else if (path.startsWith('/blog')) {
        await expect(page.locator('article').first()).toBeVisible();
      } else {
        await expect(page.locator('article h1')).toBeVisible();
        await expect(page.locator('#main-content')).toBeVisible();
      }
    }
  });

  test(`${locale || 'en'} signup controls reach the matching intercepted Product signup @mobile`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    const destination = await page
      .locator('header a[href$="/auth/signup"]')
      .first()
      .getAttribute('href');
    expect(destination).toBeTruthy();
    const requests: string[] = [];
    await page.route(destination!, async (route) => {
      requests.push(route.request().url());
      expect(route.request().method()).toBe('GET');
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>Intercepted Product signup</h1>',
      });
    });
    for (const selector of [
      'header a[href$="/auth/signup"]',
      'main section:first-child a[href$="/auth/signup"]',
      '#pricing a[href$="/auth/signup"] >> nth=0',
      '#pricing a[href$="/auth/signup"] >> nth=1',
      '#next-day a[href$="/auth/signup"]',
    ]) {
      await page.goto(locale || '/');
      await page.locator(selector).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(destination!);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Intercepted Product signup',
      );
    }
    expect(requests).toEqual(Array(5).fill(destination));
  });

  test(`${locale || 'en'} landing explanations open and close their answers @mobile`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    for (const selector of ['#learning details', '#google-calendar details']) {
      const disclosure = page.locator(selector);
      await expect(disclosure).not.toHaveAttribute('open', '');
      await disclosure.locator('summary').click();
      await expect(disclosure).toHaveAttribute('open', '');
      await expect(disclosure.locator('p')).toBeVisible();
      await disclosure.locator('summary').click();
      await expect(disclosure.locator('p')).not.toBeVisible();
    }
  });

  test(`${locale || 'en'} article breadcrumbs and related articles preserve locale`, async ({
    page,
  }) => {
    await page.goto(`${locale}/blog`);
    await page.locator('article a[href*="/blog/"]').first().click();
    const initialTitle = await page.locator('article h1').textContent();
    const initialURL = page.url();
    const related = page.locator('main section article a[href*="/blog/"]').first();
    const relatedHref = await related.getAttribute('href');
    expect(relatedHref).toMatch(new RegExp(`^${locale}/blog/`));
    await related.click();
    await expect(page).toHaveURL(new URL(relatedHref!, initialURL).href);
    await expect(page.locator('article h1')).not.toHaveText(initialTitle!);
    await page.goto(initialURL);
    const category = page.locator('nav[aria-label="breadcrumb"] a').last();
    const categoryHref = await category.getAttribute('href');
    await category.click();
    await expect(page).toHaveURL(new URL(categoryHref!, initialURL).href);
    await expect(
      page.locator(`main nav[aria-label="${ja ? 'ブログ' : 'Blog'}"] a[href="${categoryHref}"]`),
    ).toHaveAttribute('aria-current', 'page');
    await page.goto(initialURL);
    await page.locator('nav[aria-label="breadcrumb"] a').first().click();
    await expect(page).toHaveURL(new RegExp(`${locale}/blog/?$`));
    await page.goto(initialURL);
    await page.locator(`main section a[href="${locale}/blog"]`).click();
    await expect(page).toHaveURL(new RegExp(`${locale}/blog/?$`));
    await expect(page.locator('article').first()).toBeVisible();
  });

  test(`${locale || 'en'} footer legal routes and OSS notice text are usable`, async ({
    page,
    baseURL,
  }) => {
    await page.goto(locale || '/');
    await page.locator('aside').getByRole('button').first().click();
    for (const legal of ['terms', 'privacy', 'cookies', 'refund', 'tokushoho']) {
      await page.goto(locale || '/');
      await page.locator(`footer a[href="${locale}/legal/${legal}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${locale}/legal/${legal}/?$`));
      await expect(page.locator('main h1')).toBeVisible();
    }
    await page.goto(`${locale}/legal/oss-credits`);
    const [noticePage] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('main a[href="/THIRD_PARTY_NOTICES.txt"]').click(),
    ]);
    await expect(noticePage).toHaveURL(new URL('/THIRD_PARTY_NOTICES.txt', baseURL!).href);
    await expect(noticePage.locator('body')).toContainText('Dayopt - Third Party Notices');
    await expect(noticePage.locator('body')).toContainText('Apache License 2.0');
    await noticePage.close();
  });

  test(`${locale || 'en'} search button opens a result without keyboard submission @mobile`, async ({
    page,
  }) => {
    await page.goto(`${locale}/search`);
    await page.locator('main input').fill('calendar');
    await page
      .locator('main')
      .getByRole('button', { name: ja ? '検索' : 'Search', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${locale}/search\\?q=calendar$`));
    const result = page.locator(`main a[href^="${locale}/docs/"]`).first();
    const href = await result.getAttribute('href');
    await result.click();
    await expect(page).toHaveURL(new URL(href!, page.url()).href);
    await expect(page.locator('article h1')).toBeVisible();
  });
}

for (const failure of ['success', 'AbortError', 'NotAllowedError']) {
  test(`native share ${failure} is handled without an uncaught error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((name: string) => {
      window.addEventListener('unhandledrejection', (event) => {
        sessionStorage.setItem('e2e-share-rejection', event.reason?.name ?? 'Unknown error');
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          sessionStorage.setItem('e2e-shared-data', JSON.stringify(data));
          if (name === 'success') return;
          throw new DOMException('Test native sharing outcome', name);
        },
      });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value: string) => sessionStorage.setItem('e2e-copy', value) },
      });
    }, failure);
    await page.goto('/blog');
    await page.locator('article a[href*="/blog/"]').first().click();
    await expect(page).toHaveURL(/\/blog\/[^/?#]+$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(`${new URL(page.url()).pathname}$`),
    );
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    const title = await page.locator('article h1').textContent();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('e2e-shared-data')))
      .toBe(JSON.stringify({ title, url: canonical }));
    if (failure === 'NotAllowedError') {
      await expect(page.getByText('URL copied to clipboard')).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('e2e-copy'))).toBe(canonical);
    } else {
      expect(await page.evaluate(() => sessionStorage.getItem('e2e-copy'))).toBeNull();
      await expect(page.getByText('URL copied to clipboard')).not.toBeVisible();
    }
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(await page.evaluate(() => sessionStorage.getItem('e2e-share-rejection'))).toBeNull();
    expect(errors).toEqual([]);
  });
}
