import { test as base } from '@playwright/test';

/** No browser request from the isolated lane can reach an external provider. */
export const test = base.extend<{
  isolatedOrigins: Set<string>;
  allowIsolatedOrigin: (origin: string) => void;
  isolatedNetwork: void;
}>({
  isolatedOrigins: async ({}, run) => {
    await run(new Set());
  },
  allowIsolatedOrigin: async ({ isolatedOrigins }, run) => {
    await run((origin) => {
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.origin !== origin
      ) {
        throw new Error('An isolated loopback origin is required');
      }
      isolatedOrigins.add(origin);
    });
  },
  isolatedNetwork: [
    async ({ context, baseURL, isolatedOrigins }, use) => {
      if (!baseURL || process.env.E2E_PREVIEW_ORIGIN)
        throw new Error('Isolated Product origin required');
      const product = new URL(baseURL);
      const database = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
      for (const url of [product, database]) {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
          throw new Error('Isolated browser requires loopback origins');
        }
      }
      isolatedOrigins.add(product.origin);
      isolatedOrigins.add(database.origin);
      await context.route('**/*', (route) =>
        isolatedOrigins.has(new URL(route.request().url()).origin)
          ? route.continue()
          : route.abort('blockedbyclient'),
      );
      await use();
      await context.unrouteAll({ behavior: 'wait' });
    },
    { auto: true },
  ],
});
