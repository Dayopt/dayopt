import { BROWSER_TELEMETRY_CONSENT_STORAGE_KEY } from '@dayopt/observability';
import { expect, test, type Page } from './public-test';

async function fillContact(page: Page) {
  await page.locator('#name').fill('Browser Example');
  await page.locator('#email').fill('browser@example.test');
  await page.locator('#category-question').click();
  await page.locator('#message').fill('An intercepted browser verification message.');
}

for (const locale of ['', '/ja']) {
  const ja = locale === '/ja';

  test(`${locale || 'en'} contact validation is associated with its fields and every category submits its selected value @mobile`, async ({
    page,
  }) => {
    const categories: string[] = [];
    await page.route('**/api/contact', async (route) => {
      categories.push(route.request().postDataJSON().category);
      await route.fulfill({ status: 200, json: { success: true } });
    });
    await page.goto(`${locale}/contact`);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#name')).toBeFocused();
    for (const field of ['name', 'email', 'message']) {
      await expect(page.locator(`#${field}`)).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator(`#${field}`)).toHaveAttribute(
        'aria-describedby',
        new RegExp(`${field}-error`),
      );
    }
    await expect(page.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');
    expect(categories).toEqual([]);
    await page.locator('#name').fill('x'.repeat(51));
    await page.locator('#email').fill('invalid-address');
    await page.locator('#message').fill('x'.repeat(1001));
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#name-error')).toContainText('50');
    await expect(page.locator('#message-error')).toContainText('1000');
    expect(categories).toEqual([]);
    for (const category of ['bug', 'feature', 'question', 'other']) {
      await fillContact(page);
      await page.locator(`#category-${category}`).click();
      await page.locator('button[type="submit"]').click();
      await expect(page.getByRole('status')).toBeVisible();
      expect(categories.at(-1)).toBe(category);
      await page
        .getByRole('button', { name: ja ? '新しいメッセージを送信' : 'Send New Message' })
        .click();
      await expect(page.locator('#name')).toHaveValue('');
    }
    expect(categories).toEqual(['bug', 'feature', 'question', 'other']);
  });

  test(`${locale || 'en'} contact required labels and privacy link use the selected language`, async ({
    page,
  }) => {
    await page.route('**/api/contact', (route) => route.abort());
    await page.goto(`${locale}/contact`);
    await expect(
      page.locator('form label').filter({ hasText: ja ? '※必須' : 'Required' }),
    ).toHaveCount(4);
    await page.locator('form a[href$="/legal/privacy"]').click();
    await expect(page).toHaveURL(new RegExp(`${locale}/legal/privacy/?$`));
    await expect(page.locator('main h1')).toBeVisible();
  });

  test(`${locale || 'en'} contact handles network and rate-limit failures, prevents duplicate pending sends and renews edited requests`, async ({
    page,
  }) => {
    const payloads: Array<{ submissionId: string; message: string }> = [];
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    await page.route('**/api/contact', async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 1) {
        await route.abort('failed');
        return;
      }
      if (payloads.length === 2) {
        await pending;
        await route.fulfill({ status: 429, json: { error: 'rate_limited' } });
        return;
      }
      await route.fulfill({ status: 200, json: { success: true } });
    });
    await page.goto(`${locale}/contact`);
    await fillContact(page);
    const send = page.locator('button[type="submit"]');
    await send.click();
    await expect(page.locator('form [role="alert"]')).toBeVisible();
    expect(payloads).toHaveLength(1);
    await send.click();
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('aria-busy', 'true');
    expect(payloads).toHaveLength(2);
    releasePending();
    await expect(send).toBeEnabled();
    await expect(page.locator('form [role="alert"]')).toBeVisible();
    expect(payloads[1]!.submissionId).toBe(payloads[0]!.submissionId);
    await page.locator('#message').fill('An edited intercepted browser verification message.');
    await send.click();
    await expect(page.getByRole('status')).toContainText(
      ja ? 'メッセージを送信しました' : 'Message Sent Successfully',
    );
    expect(payloads).toHaveLength(3);
    expect(payloads[2]!.submissionId).not.toBe(payloads[1]!.submissionId);
  });

  test(`${locale || 'en'} docs sidebar, next and previous navigation preserve locale`, async ({
    page,
  }) => {
    await page.goto(`${locale}/docs`);
    const sidebarLink = page.locator('aside nav a[href$="/docs/plans"]');
    await sidebarLink.click();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/plans/?$`));
    const title = await page.locator('article h1').textContent();
    await page
      .locator('main')
      .getByRole('link', { name: ja ? /次へ/ : /^Next/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/`));
    await expect(page.locator('article h1')).not.toHaveText(title!);
    await page
      .locator('main')
      .getByRole('link', { name: ja ? /前へ/ : /^Previous/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/plans/?$`));
    await expect(page.locator('article h1')).toHaveText(title!);
  });

  test(`${locale || 'en'} docs table of contents navigates to a reloadable heading and issue reporting`, async ({
    page,
  }) => {
    await page.goto(`${locale}/docs/plans`);
    const toc = page.locator('main aside nav button').last();
    const label = await toc.getAttribute('title');
    await toc.click();
    await expect(page).toHaveURL(/#.+/);
    const id = new URL(page.url()).hash.slice(1);
    await expect(page.locator(`[id=${JSON.stringify(decodeURIComponent(id))}]`)).toContainText(
      label!,
    );
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/plans#`));
    await page.locator('main aside a[href$="/contact"]').click();
    await expect(page).toHaveURL(new RegExp(`${locale}/contact/?$`));
    await expect(page.locator('#message')).toBeVisible();
  });

  test(`${locale || 'en'} docs search previews open articles and recent queries survive reload`, async ({
    page,
  }) => {
    await page.goto(`${locale}/docs`);
    const open = page.locator('aside button').first();
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await dialog.getByRole('textbox').fill('calendar');
    const preview = dialog
      .locator('button')
      .filter({ has: page.locator('span') })
      .filter({ hasText: ja ? 'ドキュメント' : 'Docs' })
      .first();
    await expect(preview).toBeVisible();
    await preview.click();
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/`));
    await open.click();
    await dialog.getByRole('textbox').fill('calendar');
    await dialog.getByRole('textbox').press('Enter');
    await expect(page).toHaveURL(new RegExp(`${locale}/search\\?q=calendar`));
    await page.goto(`${locale}/docs`);
    await open.click();
    await dialog.getByRole('button', { name: 'calendar', exact: true }).click();
    await expect(dialog.getByRole('textbox')).toHaveValue('calendar');
    await dialog.getByRole('textbox').press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(open).toBeFocused();
  });

  test(`${locale || 'en'} missing docs route offers a working localized home recovery`, async ({
    page,
  }) => {
    const response = await page.goto(`${locale}/docs/e2e-missing-document`);
    expect(response?.status()).toBe(404);
    await page
      .locator('main')
      .getByRole('link', { name: ja ? 'ホームに戻る' : 'Back to Home' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${locale || ''}/?$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      ja ? '一日を重ねて、' : 'One day at a time,',
    );
  });
}

test('cookie revocation can be cancelled without losing an entered contact message', async ({
  page,
}) => {
  await page.route('**/api/contact', (route) => route.abort());
  await page.goto('/contact');
  await page.getByRole('button', { name: 'Allow analytics' }).click();
  await page.locator('#message').fill('Unsaved contact message to preserve.');
  await page.getByRole('button', { name: 'Cookie settings' }).click();
  await page.getByRole('button', { name: 'Necessary only' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep current choice' }).click();
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Change your cookie choice' })).toContainText(
    'Analytics is currently allowed.',
  );
  await expect(page.locator('#message')).toHaveValue('Unsaved contact message to preserve.');
});

test('cookie settings reports rejected storage writes and preserves the saved choice', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Necessary only' }).click();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Storage denied', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
  await page.getByRole('button', { name: 'Cookie settings' }).click();
  await page.getByRole('button', { name: 'Allow analytics' }).click();
  await expect(page.locator('aside [role="alert"]')).toContainText('Could not save your choice.');
  await expect(page.getByRole('region', { name: 'Change your cookie choice' })).toContainText(
    'Analytics is currently refused.',
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).analytics,
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
    ),
  ).toBe(false);
});

test('first cookie choice remains available when storage rejects the write', async ({ page }) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Storage denied', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
  await page.goto('/');
  await page.getByRole('button', { name: 'Allow analytics' }).click();
  await expect(page.locator('aside [role="alert"]')).toContainText('Could not save your choice.');
  await expect(page.getByRole('button', { name: 'Necessary only' })).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), BROWSER_TELEMETRY_CONSENT_STORAGE_KEY),
  ).toBeNull();
});

test('keyboard navigation closes responsive menus and restores the triggering control @mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Necessary only' }).click();
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    const trigger = page.getByRole('button', { name: 'Open menu' });
    await trigger.focus();
    await trigger.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(trigger).toBeFocused();
  } else {
    const trigger = page.getByRole('button', { name: 'Change theme' });
    await trigger.focus();
    await trigger.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  const question = page.locator('#faq summary').first();
  await question.focus();
  await question.press('Enter');
  await expect(page.locator('#faq details').first()).toHaveAttribute('open', '');
  await question.press('Space');
  await expect(page.locator('#faq details').first()).not.toHaveAttribute('open', '');
});
