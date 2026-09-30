import AxeBuilder from '@axe-core/playwright';
import { BROWSER_TELEMETRY_CONSENT_STORAGE_KEY } from '@dayopt/observability';
import { expect, type Page, type Route, test } from '@playwright/test';

import { appTrialDays } from '@dayopt/billing';
import commonEn from '../../../messages/en/common.json' with { type: 'json' };
import en from '../../../messages/en/marketing.json' with { type: 'json' };
import commonJa from '../../../messages/ja/common.json' with { type: 'json' };
import ja from '../../../messages/ja/marketing.json' with { type: 'json' };

const locales = [
  {
    locale: 'en',
    path: '/',
    copy: en.marketing.landing,
    pricingCopy: en.marketing.pricing.singlePlan,
    common: commonEn.common,
  },
  {
    locale: 'ja',
    path: '/ja',
    copy: ja.marketing.landing,
    pricingCopy: ja.marketing.pricing.singlePlan,
    common: commonJa.common,
  },
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

for (const { locale, path, copy, pricingCopy, common } of locales) {
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
          const section = page.locator(`#${id}`);
          await section.scrollIntoViewIfNeeded();
          await page.evaluate(() => document.fonts.ready);
          await expect(section).toBeVisible();
          // 画面外の content-visibility を変更せず、表示した実セクションを記録する。
          const sectionImage = await section.screenshot();
          await testInfo.attach(`lp-${locale}-${colorScheme}-${width}-${id}`, {
            body: sectionImage,
            contentType: 'image/png',
          });
        }
        await page.locator('footer').scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        expect(await overflowingContent(page)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        const screenshot = testInfo.outputPath(`lp-${locale}-${colorScheme}-${width}.png`);
        await page.evaluate(() => window.scrollTo(0, 0));
        // 全ページ撮影ではブラウザーが画面外の描画を省くため、撮影中だけ全体を描画する。
        // 操作・構図・個別画像の検証は上の production CSS のまま行う。
        const captureStyle = await page.addStyleTag({
          content: '[data-locale] > section { content-visibility: visible !important; }',
        });
        await page.screenshot({ path: screenshot, fullPage: true });
        await captureStyle.evaluate((element) => element.parentNode?.removeChild(element));
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

  test(`${locale}: 最後のロゴを Enter と Space で再生できる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(path);
    const replay = page.getByRole('button', { name: copy.closing.replay });
    await replay.scrollIntoViewIfNeeded();
    await expect(replay).toBeEnabled();
    // 初回表示のアニメーションを終えてから、キー操作で新しく起きた再生だけを数える。
    await replay.evaluate(async (button) => {
      await Promise.all(
        button.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
      button.setAttribute('data-replays', '0');
      button.addEventListener('animationstart', () => {
        button.setAttribute(
          'data-replays',
          String(Number(button.getAttribute('data-replays')) + 1),
        );
      });
    });
    await replay.focus();
    await page.keyboard.press('Enter');
    await expect(replay).toHaveAttribute('data-replays', '1');
    await page.keyboard.press('Space');
    await expect(replay).toHaveAttribute('data-replays', '2');
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
    const wednesday = week.getByRole('radio', { name: new RegExp(`^${copy.review.days[2]}:`) });
    await wednesday.click();
    await expect(wednesday).toBeChecked();
    await expect(week.locator('figcaption [data-index="2"]')).toBeVisible();
    await expect(week.locator('figcaption [data-index="2"]')).toContainText('135');
    const friday = week.getByRole('radio', { name: new RegExp(`^${copy.review.days[4]}:`) });
    await friday.click();
    await expect(wednesday).not.toBeChecked();
    await expect(week.locator('figcaption [data-index="2"]')).not.toBeVisible();
    await expect(week.locator('figcaption [data-index="4"]')).toBeVisible();
    await expect(week.locator('figcaption [data-index="4"]')).toContainText('180');
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
    const select = page.getByRole('combobox', { name: common.aria.changeTheme });
    await expect(select).toBeEnabled();
    await select.selectOption('dark');
    await expect(select).toHaveValue('dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await select.selectOption('light');
    await expect(select).toHaveValue('light');
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
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(copy.hero.title1);
    await expect(page.locator('#day-experience [data-plan-duration="30"]')).toBeVisible();
    await expect(page.locator('#day-experience [data-record-duration="45"]')).toBeVisible();
    const calendar = page.locator('#calendar-preview');
    const tomorrow = calendar.getByRole('radio', { name: copy.calendar.stepNext, exact: true });
    await tomorrow.check();
    await expect(tomorrow).toBeChecked();
    await expect(calendar.getByText(copy.calendar.dateNext, { exact: true })).toBeVisible();
    const rhythm = page.locator('#learning');
    await expect(rhythm.getByText(copy.templates.feedbackAfter, { exact: true })).not.toBeVisible();
    await rhythm.locator('summary').filter({ hasText: copy.templates.apply }).click();
    await expect(rhythm.getByText(copy.templates.feedbackAfter, { exact: true })).toBeVisible();
    await rhythm.locator('summary').filter({ hasText: copy.templates.reset }).click();
    await expect(rhythm.getByText(copy.templates.feedbackAfter, { exact: true })).not.toBeVisible();
    const week = page.locator('#review');
    const wednesday = week.getByRole('radio', { name: new RegExp(`^${copy.review.days[2]}:`) });
    await expect(week.locator('figcaption [data-index="2"]')).not.toBeVisible();
    await wednesday.check();
    await expect(week.locator('figcaption [data-index="2"]')).toBeVisible();
    await expect(week.locator('figcaption [data-index="2"]')).toContainText('135');
    const pricing = page.locator('#pricing');
    await expect(pricing.getByText('$0', { exact: true })).toHaveCount(0);
    await expect(pricing.getByText(/^\$5\s*\//)).toBeVisible();
    await expect(
      pricing.getByText(pricingCopy.trial.replace('{days}', String(appTrialDays)), { exact: true }),
    ).toBeVisible();
    await expect(pricing.locator('a[href$="/auth/signup"]')).toHaveCount(1);
    // Native details summaries are activated directly with JavaScript disabled.
    await page.locator('#faq summary').filter({ hasText: copy.faq.q7 }).click();
    await expect(page.getByText(copy.faq.a7, { exact: true })).toBeVisible();
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

  test(`${locale}: 単一プランの条件と体験終了後のFAQを確認できる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.goto(path);
    const pricing = page.locator('#pricing');
    await expect(pricing.getByText('$0', { exact: true })).toHaveCount(0);
    await expect(pricing.getByText(/^\$5\s*\//)).toBeVisible();
    await expect(
      pricing.getByText(pricingCopy.trial.replace('{days}', String(appTrialDays)), { exact: true }),
    ).toBeVisible();
    await expect(pricing.getByText(pricingCopy.renewal, { exact: true })).toBeVisible();
    await expect(pricing.locator('a[href$="/auth/signup"]')).toHaveCount(1);
    await expect(pricing.locator('a[href$="/auth/signup"]')).toHaveAttribute(
      'href',
      /^https:\/\/[^/]+\/auth\/signup$/,
    );
    const answer = page.getByText(copy.faq.a8, { exact: true });
    await expect(answer).not.toBeVisible();
    await page.locator('#faq summary').filter({ hasText: copy.faq.q8 }).click();
    await expect(answer).toBeVisible();
    await page.locator('#faq summary').filter({ hasText: copy.faq.q8 }).click();
    await expect(answer).not.toBeVisible();
    for (const link of await page
      .locator('header a')
      .filter({ hasText: common.actions.login })
      .all()) {
      await expect(link).toHaveAttribute('href', /^https:\/\/[^/]+\/auth\/login$/);
    }
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

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${locale} ${colorScheme}: 記録カードの登場途中でも文字のコントラストを保つ`, async ({
      page,
    }) => {
      await refuseAnalytics(page);
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(path);
      const demo = page.locator('#day-experience');
      await demo.getByRole('button', { name: copy.experience.stepPlan, exact: true }).click();
      await expect(demo.locator('[data-record-duration]')).toHaveCount(0);
      await demo.getByRole('button', { name: copy.experience.stepRecord, exact: true }).click();
      const heldTransitions = await demo.locator('[data-record-duration]').evaluate((card) => {
        const transitions = card.getAnimations({ subtree: true });
        for (const animation of transitions) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getTiming().duration) / 10;
        }
        return transitions.length;
      });
      // Hold the real browser transition near its start, ensuring this check
      // exercises the entrance instead of passing after the motion has ended.
      expect(heldTransitions).toBeGreaterThan(0);
      const audit = await new AxeBuilder({ page })
        // The reported regression affects the small minute unit. The decorative
        // SVG behind other labels requires a separate manual contrast review.
        .include('#day-experience [data-record-duration] small')
        .withRules(['color-contrast'])
        .analyze();
      expect(audit.violations).toEqual([]);
      expect(audit.incomplete).toEqual([]);
    });
  }

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

  test(`${locale}: 320px でロゴと登録が重ならずメニューからログインできる`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      storageState: testInfo.project.use.storageState,
      viewport: { width: 320, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await refuseAnalytics(page);
    await page.goto(new URL(path, testInfo.project.use.baseURL as string).href);
    await page.evaluate(() => document.fonts.ready);
    const header = page.locator('header');
    const logo = await header.getByRole('link', { name: 'Dayopt', exact: true }).boundingBox();
    const signup = header.getByRole('link', { name: common.actions.signup, exact: true });
    const signupBox = await signup.boundingBox();
    expect(logo!.x + logo!.width).toBeLessThan(signupBox!.x);
    await expect(signup).toHaveAttribute('href', /^https:\/\/[^/]+\/auth\/signup$/);
    await expect(header.getByRole('link', { name: common.actions.login, exact: true })).toHaveCount(
      0,
    );
    await header.getByRole('button', { name: common.aria.openMenu }).tap();
    const menu = page.getByRole('dialog', { name: common.aria.navigationMenu });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole('link', { name: common.actions.login, exact: true }),
    ).toHaveAttribute('href', /^https:\/\/[^/]+\/auth\/login$/);
    await menu.getByRole('button', { name: common.aria.closeMenu }).tap();
    await expect(menu).toHaveCount(0);
    await context.close();
  });

  test(`${locale}: メニューの読み込み中も Escape で開く操作を取り消せる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    // 初期の React コードが動いたことを、操作による表示変化で確認してから遅延する。
    const plan = page
      .locator('#day-experience')
      .getByRole('button', { name: copy.experience.stepPlan });
    await plan.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    let resumeRequests: () => void = () => {};
    const pauseRequests = new Promise<void>((resolve) => {
      resumeRequests = resolve;
    });
    const pending: Promise<void>[] = [];
    await page.route('**/*.js', (route: Route) => {
      const request = pauseRequests.then(() => route.continue());
      pending.push(request);
      return request;
    });
    const open = page.getByRole('button', { name: common.aria.openMenu });
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    resumeRequests();
    await Promise.all(pending);
    await page.unroute('**/*.js');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // 取り消し後にも、実際に開いて閉じられる。
    await open.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test(`${locale}: ドキュメントへ移動して戻ってもテーマとLPの構図が保たれる`, async ({ page }) => {
    await refuseAnalytics(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(path);
    await page
      .locator('header')
      .getByRole('link', { name: common.navigation.docs, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/${locale === 'ja' ? 'ja/' : ''}docs$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page
      .locator('header')
      .getByRole('link', { name: common.navigation.home, exact: true })
      .click();
    await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL as string).href);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(copy.hero.title1);
    expect(
      await page
        .getByRole('heading', { level: 1 })
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThan(70);
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await overflowingContent(page)).toEqual([]);
  });
}
