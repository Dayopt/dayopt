import { expect, test } from '@playwright/test';

test('sitemap content routes and their internal content links resolve', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  // Exercise the HTTP fallback on a real content document, not only redirects.
  await page.route('**/docs/faq/privacy-security', async (route) => {
    await route.abort();
  });
  await page.goto('/');
  const audit = await page.evaluate(async () => {
    const sitemap = await fetch('/sitemap.xml');
    if (!sitemap.ok) throw new Error(`Sitemap failed: ${sitemap.status}`);
    const xml = new DOMParser().parseFromString(await sitemap.text(), 'application/xml');
    const paths = [
      ...new Set(
        Array.from(
          xml.querySelectorAll('url > loc'),
          (node) => new URL(node.textContent!).pathname,
        ),
      ),
    ];
    const contentPaths = paths.filter((path) => /^\/(ja\/)?(docs|blog)(\/|$)/.test(path));
    const linked = new Set<string>();
    const collected = new Set<string>();
    const failures: Array<{ path: string; status: number }> = [];
    const visit = async (path: string, collect: boolean) => {
      let response: Response;
      try {
        response = await fetch(path);
      } catch {
        failures.push({ path, status: 0 });
        return;
      }
      if (!response.ok) {
        failures.push({ path, status: response.status });
        return;
      }
      if (collect) {
        const document = new DOMParser().parseFromString(await response.text(), 'text/html');
        collected.add(path);
        for (const anchor of document.querySelectorAll('main a[href]')) {
          const href = anchor.getAttribute('href')!;
          if (/^\/(ja\/)?(docs|blog)(\/|$)/.test(href))
            linked.add(new URL(href, location.origin).pathname);
        }
      }
    };
    for (let start = 0; start < contentPaths.length; start += 4)
      await Promise.all(contentPaths.slice(start, start + 4).map((path) => visit(path, true)));
    const additional = [...linked].filter((path) => !contentPaths.includes(path));
    for (let start = 0; start < additional.length; start += 4)
      await Promise.all(additional.slice(start, start + 4).map((path) => visit(path, false)));
    return {
      contentPaths,
      collectedPaths: [...collected],
      linkedPaths: [...linked],
      additionalPaths: additional,
      failures,
    };
  });
  // Retry page transport failures through HTTP, retaining link collection
  // for every recovered sitemap document before checking newly found links.
  const linked = new Set(audit.linkedPaths);
  const collected = new Set(audit.collectedPaths);
  let recoveredContentCount = 0;
  const recover = async (failure: { path: string; status: number }) => {
    const response = await fetch(new URL(failure.path, testInfo.project.use.baseURL!), {
      signal: AbortSignal.timeout(15_000),
    });
    failure.status = response.status;
    if (response.ok && audit.contentPaths.includes(failure.path)) {
      const discovered = await page.evaluate(
        (html: string) => {
          const document = new DOMParser().parseFromString(html, 'text/html');
          return Array.from(document.querySelectorAll('main a[href]'))
            .map((anchor) => anchor.getAttribute('href')!)
            .filter((href) => /^\/(ja\/)?(docs|blog)(\/|$)/.test(href))
            .map((href) => new URL(href, location.origin).pathname);
        },
        await response.text(),
      );
      for (const path of discovered) linked.add(path);
      collected.add(failure.path);
      recoveredContentCount += 1;
    }
  };
  const transportFailures = audit.failures.filter((failure) => failure.status === 0);
  for (let start = 0; start < transportFailures.length; start += 4) {
    await Promise.all(transportFailures.slice(start, start + 4).map(recover));
  }
  const unchecked = [...linked].filter(
    (path) => !audit.contentPaths.includes(path) && !audit.additionalPaths.includes(path),
  );
  for (let start = 0; start < unchecked.length; start += 4) {
    await Promise.all(
      unchecked.slice(start, start + 4).map(async (path) => {
        const response = await fetch(new URL(path, testInfo.project.use.baseURL!), {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) audit.failures.push({ path, status: response.status });
      }),
    );
  }
  audit.failures = audit.failures.filter(
    (failure) => failure.status < 200 || failure.status >= 400,
  );
  expect(audit.contentPaths.length).toBeGreaterThan(0);
  expect(linked.size).toBeGreaterThan(0);
  expect(recoveredContentCount).toBeGreaterThan(0);
  expect(collected.size).toBe(audit.contentPaths.length);
  expect(audit.failures).toEqual([]);
});
