import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.clearState();
});

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} RSS control returns a feed with article links`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${locale}/blog`);
    const href = await screen.getByRole('link', 'RSS Feed').getAttribute('href');
    expect(href).toBe(`${locale}/blog/feed.xml`);
    const response = await browser.evaluate(async (path: string) => {
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
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
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
  await app.open('/blog');
  await browser.locator('article a[href*="/blog/"]').first().tap();
  await screen.getByRole('button', 'Copy link').tap();
  await expect(screen.getByText('URL copied to clipboard')).toBeVisible();
  const copied = await browser.evaluate(() => sessionStorage.getItem('e2e-copied-text'));
  const canonical = await browser.locator('link[rel="canonical"]').getAttribute('href');
  expect(copied).toBe(canonical);
  for (const platform of ['Twitter', 'Facebook', 'LinkedIn']) {
    const href = await screen.getByRole('link', `Share on ${platform}`).getAttribute('href');
    expect(decodeURIComponent(href!)).toContain(canonical!);
  }
  await browser.evaluate(() => {
    sessionStorage.setItem('e2e-reject-copy', 'true');
    return null;
  });
  await screen.getByRole('button', 'Copy link').tap();
  await expect(screen.getByText('Failed to copy URL')).toBeVisible();
});

test('contact failed submission retries with the same ID, succeeds and resets for a new message', async ({
  app,
  browser,
  screen,
}) => {
  const payloads: Array<{ submissionId: string; message: string }> = [];
  await browser.route('**/api/contact', async (route) => {
    expect(route.request.method).toBe('POST');
    payloads.push(JSON.parse(route.request.postData!) as { submissionId: string; message: string });
    await route.fulfill({
      status: payloads.length === 1 ? 503 : 200,
      json: { success: payloads.length > 1 },
    });
  });
  await app.open('/contact');
  await browser.locator('#name').fill('TesterArmy Example');
  await browser.locator('#email').fill('testerarmy@example.test');
  await screen.getByRole('radio', 'Question').tap();
  await browser.locator('#message').fill('This is an intercepted test message.');
  await screen.getByRole('button', 'Send Message').tap();
  await expect(browser.locator('main form [role="alert"]')).toContainText(
    'Failed to send message. Please try again later.',
  );
  expect(payloads.length).toBe(1);
  await expect(browser.locator('#message')).toHaveValue('This is an intercepted test message.');
  await screen.getByRole('button', 'Send Message').tap();
  await expect(screen.getByRole('status')).toContainText('Message Sent Successfully');
  expect(payloads.length).toBe(2);
  expect(payloads[1]!.submissionId).toBe(payloads[0]!.submissionId);
  await screen.getByRole('button', 'Send New Message').tap();
  await expect(browser.locator('#message')).toHaveValue('');
  await expect(browser.locator('#name')).toHaveValue('');
  await browser.locator('#name').fill('TesterArmy Example');
  await browser.locator('#email').fill('testerarmy@example.test');
  await screen.getByRole('radio', 'Question').tap();
  await browser.locator('#message').fill('This is another intercepted test message.');
  await screen.getByRole('button', 'Send Message').tap();
  await expect(screen.getByRole('status')).toContainText('Message Sent Successfully');
  expect(payloads.length).toBe(3);
  expect(payloads[2]!.submissionId).not.toBe(payloads[1]!.submissionId);
});
