import { BROWSER_TELEMETRY_CONSENT_STORAGE_KEY } from '@dayopt/observability';
import { expect, type Page, test } from '@playwright/test';

import commonEn from '../../../messages/en/common.json' with { type: 'json' };
import en from '../../../messages/en/marketing.json' with { type: 'json' };
import commonJa from '../../../messages/ja/common.json' with { type: 'json' };
import ja from '../../../messages/ja/marketing.json' with { type: 'json' };

const locales = [
  { locale: 'en', path: '/', copy: en.marketing.landing, common: commonEn.common },
  { locale: 'ja', path: '/ja', copy: ja.marketing.landing, common: commonJa.common },
] as const;
const widths = [320, 390, 768, 1024, 1440, 1920] as const;

async function refuseAnalytics(page: Page) {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        necessary: true,
        analytics: false,
        marketing: false,
        timestamp: Date.now(),
      }),
    );
  }, BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
}

async function overflowingContent(page: Page) {
  return page.locator('[data-locale]').evaluate((landing) => {
    const viewport = document.documentElement.clientWidth;
    return Array.from(
      landing.querySelectorAll('section, h1, h2, h3, p, a, button, summary, li, [role="img"]'),
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return (
          rect.left < -1 ||
          rect.right > viewport + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      })
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}: ${element.textContent?.trim().slice(0, 50)}`,
      );
  });
}

for (const { locale, path, copy, common } of locales) {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of widths) {
      test(`${locale} ${colorScheme} ${width}px: 全セクションの構図と切れを確認`, async ({
        page,
      }, testInfo) => {
        await refuseAnalytics(page);
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('html')).toHaveClass(colorScheme === 'dark' ? /dark/ : /light/);
        await expect(page.getByRole('heading', { level: 1 })).toContainText(copy.hero.title1);
        for (const id of [
          'day-experience',
          'calendar-preview',
          'activities',
          'learning',
          'review',
          'philosophy',
          'integrations',
          'pricing',
          'faq',
          'next-day',
        ]) {
          await expect(page.locator(`#${id}`)).toBeVisible();
        }
        expect(await overflowingContent(page)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        const screenshot = testInfo.outputPath(`lp-${locale}-${colorScheme}-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach(`lp-${locale}-${colorScheme}-${width}`, {
          path: screenshot,
          contentType: 'image/png',
        });
      });
    }
  }

  test(`${locale}: キーボードで予定・記録・次の日・戻す操作`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.goto(path);
    const demo = page.locator('#day-experience');
    const planButton = demo.getByRole('button', { name: copy.experience.stepPlan });
    const recordButton = demo.getByRole('button', { name: copy.experience.stepRecord });
    const nextButton = demo.getByRole('button', { name: copy.experience.stepNext });

    await planButton.focus();
    await page.keyboard.press('Space');
    await expect(planButton).toHaveAttribute('aria-pressed', 'true');
    await expect(demo.locator('[data-record-duration]')).toHaveCount(0);
    await expect(demo.getByText(copy.experience.pending)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(recordButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(demo.locator('[data-plan-duration="30"]')).toBeVisible();
    await expect(demo.locator('[data-record-duration="45"]')).toBeVisible();
    const firstPlanHeight = (await demo.locator('[data-plan-duration]').boundingBox())!.height;
    const recordHeight = (await demo.locator('[data-record-duration]').boundingBox())!.height;
    expect(firstPlanHeight / recordHeight).toBeCloseTo(30 / 45, 1);

    await page.keyboard.press('Tab');
    await expect(nextButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(demo.locator('[data-plan-duration="45"] strong')).toHaveText('45');
    await expect(demo.locator('[data-record-day]')).toHaveAttribute('data-record-day', 'previous');
    await expect(demo.getByText(copy.experience.previousRecord, { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await demo.locator('[data-plan-duration]').boundingBox())!.height / recordHeight,
      )
      .toBeCloseTo(1, 1);
    await demo.getByRole('button', { name: copy.experience.reset }).focus();
    await page.keyboard.press('Space');
    await expect(recordButton).toHaveAttribute('aria-pressed', 'true');
    await expect(demo.locator('[data-plan-duration="30"]')).toBeVisible();
    await expect(demo.locator('[data-record-day]')).toHaveAttribute('data-record-day', 'same');
  });

  test(`${locale}: FAQ はキーボードで開閉できる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.goto(path);
    const item = page.locator('#faq details').first();
    const summary = item.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('open', '');
    await expect(item.locator('p')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(item).not.toHaveAttribute('open', '');
    await expect(item.locator('p')).not.toBeVisible();
  });

  test(`${locale}: 時間軸の目盛りと週の図版を動かせる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.goto(path);
    const demo = page.locator('#day-experience');
    const slider = demo.getByRole('slider', { name: copy.experience.probeLabel });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('60');
    await expect(demo.locator('output')).toHaveText(`10:00${copy.experience.probeRoom}`);
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('0');
    await expect(demo.locator('output')).toHaveText(`09:00${copy.experience.probeBoth}`);
    await demo.getByRole('button', { name: copy.experience.reset }).click();
    await expect(slider).toHaveValue('30');
    await expect(demo.locator('output')).toHaveText(`09:30${copy.experience.probeRecord}`);
    const week = page.locator('#review');
    const wednesday = week.getByRole('button', { name: new RegExp(`^${copy.review.days[2]}:`) });
    await wednesday.click();
    await expect(wednesday).toHaveAttribute('aria-pressed', 'true');
    await expect(week.locator('figcaption')).toContainText('135');
    const friday = week.getByRole('button', { name: new RegExp(`^${copy.review.days[4]}:`) });
    await friday.click();
    await expect(wednesday).toHaveAttribute('aria-pressed', 'false');
    await expect(week.locator('figcaption')).toContainText('180');
  });

  test(`${locale}: モバイルで説明を切り替えても操作ボタンの位置が動かない`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    const controls = page.locator('#day-experience').getByRole('group');
    const positions: number[] = [];
    for (const button of await controls.getByRole('button').all()) {
      await button.click();
      positions.push(
        await controls.evaluate((element) => element.getBoundingClientRect().top + scrollY),
      );
    }
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
  });

  test(`${locale}: フッターからテーマを切り替えられる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(path);
    await page.getByRole('button', { name: common.aria.changeTheme }).click();
    await page.getByRole('menuitemcheckbox', { name: common.theme.dark, exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: common.aria.changeTheme }).click();
    await page.getByRole('menuitemcheckbox', { name: common.theme.light, exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
  });

  test(`${locale}: JavaScript 無効でも内容・FAQ・登録先が成立する`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      storageState: testInfo.project.use.storageState,
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(new URL(path, testInfo.project.use.baseURL as string).href);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(copy.hero.title1);
    await expect(page.locator('#day-experience [data-plan-duration="30"]')).toBeVisible();
    await expect(page.locator('#day-experience [data-record-duration="45"]')).toBeVisible();
    await expect(page.locator('#pricing')).toContainText('7');
    await page.locator('#faq summary').first().click();
    await expect(page.locator('#faq details').first()).toHaveAttribute('open', '');
    const signup = page.getByRole('link', { name: new RegExp(copy.hero.cta) }).first();
    await expect(signup).toHaveAttribute('href', /^https:\/\/[^/]+\/auth\/signup$/);
    const screenshot = testInfo.outputPath(`lp-${locale}-no-javascript.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`lp-${locale}-no-javascript`, {
      path: screenshot,
      contentType: 'image/png',
    });
    await context.close();
  });

  test(`${locale}: 200%拡大相当の720px表示で1440px画面からリフローする`, async ({
    browser,
  }, testInfo) => {
    // 1440 physical pixels at 200% zoom: 720 CSS pixels rendered at scale 2.
    const context = await browser.newContext({
      storageState: testInfo.project.use.storageState,
      viewport: { width: 720, height: 500 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await refuseAnalytics(page);
    await page.goto(new URL(path, testInfo.project.use.baseURL as string).href);
    expect(await overflowingContent(page)).toEqual([]);
    await expect(page.getByRole('link', { name: new RegExp(copy.hero.cta) }).first()).toBeVisible();
    const screenshot = testInfo.outputPath(`lp-${locale}-zoom-200.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`lp-${locale}-zoom-200`, {
      path: screenshot,
      contentType: 'image/png',
    });
    await context.close();
  });

  test(`${locale}: reduced-motion では図版の動きを止める`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(path);
    const demo = page.locator('#day-experience');
    await demo.getByRole('button', { name: copy.experience.stepNext }).click();
    const durations = await demo.locator('[data-plan-duration]').evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(',')
        .map((value) => parseFloat(value)),
    );
    // The shared reduced-motion foundation uses 0.01ms to preserve transition events.
    expect(Math.max(...durations)).toBeLessThanOrEqual(0.00001);
    await expect(demo.locator('svg')).toHaveCSS('stroke-dashoffset', '0px');
    await expect(demo.getByRole('heading')).toHaveText(copy.experience.nextTitle);
  });

  test(`${locale}: タッチでデモとモバイルメニューを操作できる`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      storageState: testInfo.project.use.storageState,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await refuseAnalytics(page);
    await page.goto(new URL(path, testInfo.project.use.baseURL as string).href);
    const demo = page.locator('#day-experience');
    await demo.getByRole('button', { name: copy.experience.stepPlan }).tap();
    await expect(demo.locator('[data-record-duration]')).toHaveCount(0);
    await demo.getByRole('button', { name: copy.experience.stepNext }).tap();
    await expect(demo.locator('[data-plan-duration="45"]')).toBeVisible();
    await demo.getByRole('button', { name: copy.experience.reset }).tap();
    await expect(demo.locator('[data-plan-duration="30"]')).toBeVisible();
    await page.getByRole('button', { name: common.aria.openMenu }).tap();
    await expect(page.getByRole('dialog', { name: common.aria.navigationMenu })).toBeVisible();
    await page.getByRole('button', { name: common.aria.closeMenu }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
  });
}
