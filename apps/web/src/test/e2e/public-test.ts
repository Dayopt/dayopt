import { test as base, expect } from '@playwright/test';

/** Public journeys exercise browser state; no provider receives test traffic. */
export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error('Public Web E2E requires an explicit base URL');
    const origin = new URL(baseURL).origin;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        !['GET', 'HEAD'].includes(request.method()) ||
        url.pathname.startsWith('/_vercel/')
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await use(context);
  },
});

export type { Page } from '@playwright/test';
export { expect };
