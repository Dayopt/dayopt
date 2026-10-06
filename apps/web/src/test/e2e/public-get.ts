import type { APIRequestContext } from '@playwright/test';

function sameOriginURL(path: string, baseURL: string): URL {
  const base = new URL(baseURL);
  const target = new URL(path, base);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    target.origin !== base.origin ||
    target.username ||
    target.password
  ) {
    throw new Error('Public Web GET requires the same origin without URL credentials');
  }
  return target;
}

/** Node fallback never follows redirects outside the browser's network fence. */
export async function publicFetchGet(path: string, baseURL: string) {
  const target = sameOriginURL(path, baseURL);
  return fetch(target, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}

/** Follow compatibility redirects only after checking each origin ourselves. */
export async function publicRequestGet(
  request: Pick<APIRequestContext, 'get'>,
  path: string,
  baseURL: string,
) {
  let target = sameOriginURL(path, baseURL);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await request.get(target.href, { maxRedirects: 0, timeout: 15_000 });
    if (![301, 302, 303, 307, 308].includes(response.status())) return response;
    const location = response.headers().location;
    await response.dispose();
    if (!location) throw new Error('Public Web GET redirect is missing its location');
    target = sameOriginURL(new URL(location, target).href, baseURL);
  }
  throw new Error('Public Web GET exceeded its redirect limit');
}
