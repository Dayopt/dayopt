import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseString } from 'set-cookie-parser';

import { isPassingTesterArmyPreviewReport } from '../lib/testerarmy-preview-reporter.mjs';

const ATTRIBUTES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'httponly',
  'secure',
  'samesite',
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Fail closed on attributes the SDK cannot reproduce, never concatenate Set-Cookie. */
export function previewResponseCookies(values, requestUrl, now = Date.now()) {
  if (!Array.isArray(values) || values.length > 50) throw new Error('Cookie response rejected');
  const url = new URL(requestUrl);
  return values.map((value) => {
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value))
      throw new Error('Cookie response rejected');
    const attributes = value
      .split(';')
      .slice(1)
      .map((part) => part.trim().split('=')[0].toLowerCase());
    if (
      attributes.some((attribute) => !ATTRIBUTES.has(attribute)) ||
      new Set(attributes).size !== attributes.length
    )
      throw new Error('Cookie attributes rejected');
    const cookie = parseString(value, { decodeValues: false, silent: true });
    if (!cookie?.name || typeof cookie.value !== 'string')
      throw new Error('Cookie response rejected');
    const domain = cookie.domain;
    if (domain !== undefined && domain.replace(/^\./, '').toLowerCase() !== url.hostname)
      throw new Error('Cookie domain rejected');
    if (cookie.path !== undefined && !cookie.path.startsWith('/'))
      throw new Error('Cookie path rejected');
    const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const path = cookie.path ?? defaultPath;
    if (
      cookie.maxAge !== undefined &&
      (!Number.isSafeInteger(cookie.maxAge) || Math.abs(cookie.maxAge) > 400 * 86400)
    )
      throw new Error('Cookie lifetime rejected');
    if (cookie.expires !== undefined && !Number.isFinite(cookie.expires.getTime()))
      throw new Error('Cookie lifetime rejected');
    if (cookie.expires && cookie.expires.getTime() > now + 400 * 86400_000)
      throw new Error('Cookie lifetime rejected');
    const sameSite = cookie.sameSite?.toLowerCase();
    if (sameSite !== undefined && !['strict', 'lax', 'none'].includes(sameSite))
      throw new Error('Cookie SameSite rejected');
    if (sameSite === 'none' && !cookie.secure) throw new Error('Cookie SameSite rejected');
    if (cookie.secure && url.protocol !== 'https:') throw new Error('Cookie transport rejected');
    if (cookie.name.startsWith('__Secure-') && !cookie.secure)
      throw new Error('Cookie prefix rejected');
    if (
      cookie.name.startsWith('__Host-') &&
      (!cookie.secure || domain !== undefined || path !== '/')
    )
      throw new Error('Cookie prefix rejected');
    const expires =
      cookie.maxAge !== undefined
        ? cookie.maxAge <= 0
          ? 0
          : Math.floor(now / 1000) + cookie.maxAge
        : cookie.expires === undefined
          ? undefined
          : Math.max(0, Math.floor(cookie.expires.getTime() / 1000));
    return {
      name: cookie.name,
      value: cookie.value,
      domain: domain === undefined ? url.hostname : `.${url.hostname}`,
      path,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      ...(sameSite === undefined
        ? {}
        : { sameSite: { strict: 'Strict', lax: 'Lax', none: 'None' }[sameSite] }),
      ...(expires === undefined ? {} : { expires }),
    };
  });
}

/** Runtime files only, copied from the clean committed harness; no candidate files are executed. */
export function stageTesterArmyProject(privateDirectory, trustedRoot = ROOT) {
  const privateMetadata = lstatSync(privateDirectory);
  if (
    !privateMetadata.isDirectory() ||
    privateMetadata.isSymbolicLink() ||
    (privateMetadata.mode & 0o077) !== 0
  )
    throw new Error('Private harness directory rejected');
  const directory = join(privateDirectory, 'harness');
  mkdirSync(directory, { mode: 0o700 });
  const paths = [
    'apps/product/e2e.config.ts',
    'apps/product/tsconfig.json',
    'apps/product/package.json',
    'apps/product/testerarmy',
    'apps/product/src/lib/test',
    'tsconfig.base.json',
    'scripts/runbook/testerarmy-preview-e2e.mjs',
    'scripts/lib/testerarmy-preview-reporter.mjs',
    'scripts/lib/preview-e2e-reporter.mjs',
  ];
  const sourceRoot = realpathSync(trustedRoot);
  const rejectLinks = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()))
      throw new Error('Untrusted harness source');
    if (metadata.isDirectory())
      for (const entry of readdirSync(path)) rejectLinks(join(path, entry));
  };
  for (const path of paths) {
    const source = join(trustedRoot, path);
    if (!realpathSync(source).startsWith(`${sourceRoot}/`))
      throw new Error('Untrusted harness source');
    rejectLinks(source);
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    cpSync(source, join(directory, path), { recursive: true, dereference: false });
  }
  symlinkSync(join(trustedRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  symlinkSync(
    join(trustedRoot, 'apps/product/node_modules'),
    join(directory, 'apps/product/node_modules'),
    'dir',
  );
  return join(directory, 'apps/product/e2e.config.ts');
}

export async function runTesterArmyPreviewE2E(options) {
  const { runPreviewE2E, executePreviewProcess } = await import('./preview-e2e.mjs');
  return runPreviewE2E({
    ...options,
    cloudUserIds: options.cloudUserIds ?? { desktop: randomUUID(), mobile: randomUUID() },
    validateReport: isPassingTesterArmyPreviewReport,
    execute: async (workerEnv) => {
      const config = stageTesterArmyProject(workerEnv.E2E_PREVIEW_PRIVATE_DIR);
      return executePreviewProcess(
        {
          ...workerEnv,
          E2E_TELEMETRY_DISABLED: '1',
          E2E_PRODUCT_AUTHENTICATED: '1',
          E2E_PRODUCT_ORIGIN: workerEnv.E2E_PREVIEW_ORIGIN,
        },
        { args: ['exec', 'e2e', 'run', '--config', config] },
      );
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { parsePreviewReadinessArgs } = await import('./preview-readiness.mjs');
    const { expectedMigrationVersions } = await import('../ci/production-migration-readiness.mjs');
    const request = parsePreviewReadinessArgs(process.argv.slice(2));
    const gitEnv = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'GIT_TERMINAL_PROMPT'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    const git = (args) =>
      execFileSync('git', args, {
        cwd: ROOT,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    if (git(['rev-parse', 'HEAD']) !== request.sha || git(['status', '--porcelain']) !== '')
      throw new Error('Uncommitted or mismatched harness');
    const result = await runTesterArmyPreviewE2E({
      request: { ...request, expectedMigrations: expectedMigrationVersions(ROOT) },
      onStarted: (started) => console.log(JSON.stringify({ ...started, status: 'running' })),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch {
    console.error(
      'TesterArmy Preview failed; verify committed harness, candidate readiness and scoped non-production credentials',
    );
    process.exitCode = 1;
  }
}

/** Exact origins only; credentials are sent on a single manual-fetch hop. */
export async function forwardPreviewRequest({
  route,
  browser,
  origin,
  supabaseRef,
  bypassSecret,
  privateDirectory,
  network,
  fetchImpl = fetch,
  maxBytes = 16 * 1024 * 1024,
}) {
  const url = new URL(route.request.url);
  const target =
    url.origin === origin
      ? 'preview'
      : url.origin === `https://${supabaseRef}.supabase.co`
        ? 'supabase'
        : url.origin === 'https://challenges.cloudflare.com'
          ? 'captcha'
          : 'blocked';
  if (target === 'blocked' || url.username || url.password) {
    network.push({ at: Date.now(), target: 'blocked', status: 0 });
    await route.abort();
    return;
  }
  const headers = Object.fromEntries(
    Object.entries(route.request.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  delete headers['x-vercel-protection-bypass'];
  delete headers['x-vercel-set-bypass-cookie'];
  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  if (target === 'preview') headers['x-vercel-protection-bypass'] = bypassSecret;
  if (
    route.request.postData !== undefined &&
    Buffer.byteLength(route.request.postData) > 2 * 1024 * 1024
  )
    throw new Error('Request bound exceeded');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let file;
  try {
    const response = await fetchImpl(url.href, {
      redirect: 'manual',
      method: route.request.method,
      headers,
      ...(route.request.postData === undefined ? {} : { body: route.request.postData }),
      signal: controller.signal,
    });
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
      throw new Error('Response bound exceeded');
    const chunks = [];
    let length = 0;
    if (response.body)
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > maxBytes) {
          controller.abort();
          throw new Error('Response bound exceeded');
        }
        chunks.push(Buffer.from(chunk));
      }
    const setCookies = response.headers.getSetCookie();
    if (setCookies.some((value) => /(?:^|;)\s*expires=/i.test(value))) {
      const responseDate = Date.parse(response.headers.get('date') ?? '');
      if (!Number.isFinite(responseDate) || Math.abs(Date.now() - responseDate) >= 1000)
        throw new Error('Cookie clock boundary rejected');
    }
    const cookies = previewResponseCookies(setCookies, url.href);
    if (cookies.length) await browser.setCookies(cookies);
    const responseHeaders = Object.fromEntries(response.headers);
    for (const key of ['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding'])
      delete responseHeaders[key];
    file = join(privateDirectory, `${randomUUID()}.bin`);
    writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
    await route.fulfill({ status: response.status, headers: responseHeaders, path: file });
    network.push({ at: Date.now(), target, status: response.status });
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (file) unlinkSync(file);
  }
}
