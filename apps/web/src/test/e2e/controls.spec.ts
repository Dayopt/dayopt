import { expect, test } from './public-test';

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} RSS control returns a feed with article links`, async ({ page }) => {
    await page.goto(`${locale}/blog`);
    const href = await page.getByRole('link', { name: 'RSS Feed' }).getAttribute('href');
    expect(href).toBe(`${locale}/blog/feed.xml`);
    const response = await page.evaluate(async (path: string) => {
      const result = await fetch(path);
      const text = await result.text();
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      return {
        status: result.status,
        contentType: result.headers.get('content-type'),
        text,
        channelDescription: xml.querySelector('channel > description')?.textContent ?? null,
      };
    }, href!);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('xml');
    expect(response.text).toContain('<rss');
    expect(response.text).toContain('<item>');
    expect(response.channelDescription).toContain(
      locale === '/ja'
        ? '予定と記録を、ひとつのカレンダーに。'
        : 'Your plans and records, together in one calendar.',
    );
    expect(response.text).toMatch(/<link>https?:\/\/[^<]+\/(ja\/)?blog\/.+<\/link>/);
  });
}

test('blog copy-link copies the article canonical URL and reports clipboard failure', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (sessionStorage.getItem('e2e-reject-copy')) throw new Error('Clipboard denied');
          sessionStorage.setItem('e2e-copied-text', text);
        },
      },
    });
  });
  await page.goto('/blog');
  await page.locator('article a[href*="/blog/"]').first().click();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('URL copied to clipboard')).toBeVisible();
  const copied = await page.evaluate(() => sessionStorage.getItem('e2e-copied-text'));
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(copied).toBe(canonical);
  for (const platform of ['Twitter', 'Facebook', 'LinkedIn']) {
    const href = await page
      .getByRole('link', { name: `Share on ${platform}` })
      .getAttribute('href');
    expect(decodeURIComponent(href!)).toContain(canonical!);
  }
  await page.evaluate(() => {
    sessionStorage.setItem('e2e-reject-copy', 'true');
    return null;
  });
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Failed to copy URL')).toBeVisible();
});

test('contact failed submission retries with the same ID, succeeds and resets for a new message', async ({
  page,
}) => {
  const payloads: Array<{ submissionId: string; message: string }> = [];
  await page.route('**/api/contact', async (route) => {
    expect(route.request().method()).toBe('POST');
    payloads.push(
      JSON.parse(route.request().postData()!) as { submissionId: string; message: string },
    );
    await route.fulfill({
      status: payloads.length === 1 ? 503 : 200,
      json: { success: payloads.length > 1 },
    });
  });
  await page.goto('/contact');
  await page.locator('#name').fill('Playwright Example');
  await page.locator('#email').fill('playwright@example.test');
  await page.getByRole('radio', { name: 'Question' }).click();
  await page.locator('#message').fill('This is an intercepted test message.');
  await page.getByRole('button', { name: 'Send Message' }).click();
  await expect(page.locator('main form [role="alert"]')).toContainText(
    'Failed to send message. Please try again later.',
  );
  expect(payloads.length).toBe(1);
  await expect(page.locator('#message')).toHaveValue('This is an intercepted test message.');
  await page.getByRole('button', { name: 'Send Message' }).click();
  await expect(page.getByRole('status')).toContainText('Message Sent Successfully');
  expect(payloads.length).toBe(2);
  expect(payloads[1]!.submissionId).toBe(payloads[0]!.submissionId);
  await page.getByRole('button', { name: 'Send New Message' }).click();
  await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#name')).toHaveValue('');
  await page.locator('#name').fill('Playwright Example');
  await page.locator('#email').fill('playwright@example.test');
  await page.getByRole('radio', { name: 'Question' }).click();
  await page.locator('#message').fill('This is another intercepted test message.');
  await page.getByRole('button', { name: 'Send Message' }).click();
  await expect(page.getByRole('status')).toContainText('Message Sent Successfully');
  expect(payloads.length).toBe(3);
  expect(payloads[2]!.submissionId).not.toBe(payloads[1]!.submissionId);
});
