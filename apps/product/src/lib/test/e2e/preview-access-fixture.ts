import { test as base } from '@playwright/test';

import { previewRequestTarget, validatePreviewOrigin } from '../preview-access';

/** Local/CI tests keep their original context. Remote evidence never records raw network bodies. */
export const test = base.extend<{ previewAccess: void }>({
  previewAccess: [
    async ({ context }, use, testInfo) => {
      if (!process.env.E2E_PREVIEW_ORIGIN) {
        await use();
        return;
      }
      const origin = validatePreviewOrigin(process.env.E2E_PREVIEW_ORIGIN);
      const ref = process.env.E2E_SUPABASE_PROJECT_REF ?? '';
      const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      if (!secret || !/^[a-z]{20}$/.test(ref) || testInfo.project.use.trace !== 'off') {
        throw new Error('Preview credentials or private recording configuration is invalid');
      }
      const startedAt = Date.now();
      const network: { at: number; target: string; status: number }[] = [];
      await context.route('**/*', async (route) => {
        const target = previewRequestTarget(route.request().url(), origin, ref);
        if (target === 'blocked') {
          network.push({ at: Date.now() - startedAt, target, status: 0 });
          await route.abort('blockedbyclient');
          return;
        }
        // route.continue({headers}) also forwards overrides to redirects. Instead
        // fetch one hop and let the next browser request pass this boundary again.
        const headers = { ...route.request().headers() };
        delete headers['x-vercel-protection-bypass'];
        delete headers['x-vercel-set-bypass-cookie'];
        try {
          const response = await route.fetch({
            maxRedirects: 0,
            timeout: 30_000,
            headers: {
              ...headers,
              ...(target === 'preview' ? { 'x-vercel-protection-bypass': secret } : {}),
            },
          });
          network.push({ at: Date.now() - startedAt, target, status: response.status() });
          await route.fulfill({ response });
        } catch {
          network.push({ at: Date.now() - startedAt, target, status: 0 });
          await route.abort('failed');
        }
      });
      await use();
      await context.unrouteAll({ behavior: 'wait' });
      await testInfo.attach('preview-network', {
        body: JSON.stringify(network),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});
