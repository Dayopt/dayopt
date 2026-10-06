import { expect, test } from './public-test';

test('blog search waits for its input handler before accepting edits', async ({ page }) => {
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  let heldScripts = 0;
  await page.route('**/_next/static/**/*.js', async (route) => {
    heldScripts += 1;
    await scriptsReady;
    await route.fallback();
  });
  try {
    await page.goto('/blog?page=2', { waitUntil: 'commit' });
    const input = page.getByRole('searchbox');
    await expect(input).toBeVisible();
    expect(heldScripts).toBeGreaterThan(0);
    const acceptsEditsBeforeScripts = await input.isEnabled();
    if (acceptsEditsBeforeScripts) await input.fill('Calendar Blocking Strategy');
    releaseScripts();
    await expect(page.getByRole('button', { name: 'English - Change language' })).toBeEnabled();
    await expect(input).toBeEnabled();
    if (!acceptsEditsBeforeScripts) await input.fill('Calendar Blocking Strategy');
    await expect(page.locator('article h2').first()).toContainText('Calendar Blocking Strategy');
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
    expect(acceptsEditsBeforeScripts).toBe(false);
  } finally {
    releaseScripts();
  }
});
