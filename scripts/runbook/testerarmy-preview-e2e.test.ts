import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  forwardPreviewRequest,
  previewResponseCookies,
  stageTesterArmyProject,
} from './testerarmy-preview-e2e.mjs';

const root = resolve(import.meta.dirname, '../..');
const requireFromProduct = createRequire(join(root, 'apps/product/package.json'));

it('real staged config collects exactly three authenticated tests with synthetic ownership, without running hooks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-staged-list-'));
  const privateDirectory = join(directory, 'private');
  const evidenceDirectory = join(directory, 'evidence');
  mkdirSync(privateDirectory, { mode: 0o700 });
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  const runId = randomUUID();
  const origin = 'https://product-test-dayopt.vercel.app';
  const ref = 'abcdefghijklmnopqrst';
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      status: 'running',
      runId,
      evidenceDirectory,
      candidate: { origin, supabaseProjectRef: ref },
    }),
    { mode: 0o600 },
  );
  try {
    const config = stageTesterArmyProject(privateDirectory);
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      E2E_TELEMETRY_DISABLED: '1',
      E2E_PRODUCT_AUTHENTICATED: '1',
      E2E_PRODUCT_ORIGIN: origin,
      E2E_PREVIEW_ORIGIN: origin,
      E2E_PREVIEW_PRIVATE_DIR: privateDirectory,
      E2E_PREVIEW_EVIDENCE_DIR: evidenceDirectory,
      E2E_PREVIEW_RUN_ID: runId,
      E2E_REQUIRE_SERVICE_ROLE_SUITES: '1',
      E2E_ALLOW_NONLOCAL_SUPABASE: '1',
      E2E_SUPABASE_PROJECT_REF: ref,
      E2E_PREVIEW_CLOUD_INTENT: '1',
      E2E_PREVIEW_DESKTOP_USER_ID: randomUUID(),
      E2E_PREVIEW_MOBILE_USER_ID: randomUUID(),
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
      SUPABASE_SECRET_KEY: 'synthetic-not-a-credential',
    };
    let output = '';
    const exit = await new Promise<number>((done) => {
      const child = spawn('pnpm', ['exec', 'e2e', 'list', '--config', config], {
        cwd: root,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const deadline = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      }, 15_000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(deadline);
        done(1);
      });
      child.on('exit', (code) => {
        clearTimeout(deadline);
        done(code ?? 1);
      });
    });
    expect(exit, output).toBe(0);
    expect(
      output.split('\n').filter((line) => line.includes('[product-authenticated]')),
    ).toHaveLength(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('staging rejects a nested symlink before privileged harness files can escape', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-stage-'));
  const trusted = join(directory, 'trusted');
  const privateDirectory = join(directory, 'private');
  mkdirSync(join(trusted, 'apps/product/testerarmy'), { recursive: true });
  mkdirSync(privateDirectory, { mode: 0o700 });
  for (const file of ['e2e.config.ts', 'tsconfig.json', 'package.json'])
    writeFileSync(join(trusted, 'apps/product', file), '{}');
  writeFileSync(join(directory, 'foreign.ts'), 'throw new Error("foreign");');
  symlinkSync(join(directory, 'foreign.ts'), join(trusted, 'apps/product/testerarmy/foreign.ts'));
  try {
    expect(() => stageTesterArmyProject(privateDirectory, trusted)).toThrow(
      'Untrusted harness source',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects unsupported or ambiguous cookie scope and preserves cookie expiry/raw value', () => {
  for (const value of [
    'x=a; Partitioned',
    'x=a; Priority=High',
    'x=a; Domain=elsewhere.test',
    'x=a; Path=bad',
    'x=a; Path=/; Path=/other',
    'x=a; SameSite=None',
    'x=a; Expires=bad',
    'x=a\r\nInjected: bad',
  ]) {
    expect(() =>
      previewResponseCookies([value], 'https://product-test-dayopt.vercel.app/path'),
    ).toThrow();
  }
  expect(
    previewResponseCookies(
      ['x=raw%2F; Max-Age=0; Path=/'],
      'https://product-test-dayopt.vercel.app',
    )[0],
  ).toMatchObject({
    value: 'raw%2F',
    expires: 0,
    path: '/',
    domain: 'product-test-dayopt.vercel.app',
  });
});

it('blocks other origins without fetching and drops bypass headers from allowed provider requests', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const network: Array<unknown> = [];
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-fence-'));
  const route = (url: string) => ({
    request: {
      url,
      method: 'GET',
      headers: {
        'x-vercel-protection-bypass': 'supplied',
        'x-vercel-set-bypass-cookie': 'supplied',
      },
    },
    abort: async () => {},
    fulfill: async () => {},
  });
  const fetchImpl: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options ?? {} });
    return new Response('hello');
  };
  const options = {
    browser: { setCookies: async () => {} },
    origin: 'https://product-test-dayopt.vercel.app',
    supabaseRef: 'abcdefghijklmnopqrst',
    bypassSecret: 'synthetic',
    privateDirectory: directory,
    network,
    fetchImpl,
  };
  try {
    await forwardPreviewRequest({ ...options, route: route('https://attacker.test/') });
    expect(calls).toHaveLength(0);
    await forwardPreviewRequest({
      ...options,
      route: route('https://abcdefghijklmnopqrst.supabase.co/'),
    });
    expect(calls[0]!.options).toMatchObject({ redirect: 'manual', headers: {} });
    expect(calls[0]!.options.headers).not.toHaveProperty('x-vercel-protection-bypass');
    await forwardPreviewRequest({ ...options, route: route(options.origin) });
    expect(calls[1]!.options.headers).toHaveProperty('x-vercel-protection-bypass', 'synthetic');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('SDK file fulfillment and cookie API preserve synthetic native cookie/binary state', async () => {
  const bytes = Buffer.from([0, 255, 128, 1, 2, 10, 13]);
  const explicitExpires = new Date(Date.now() + 10 * 86400_000).toUTCString();
  const cookies = [
    'sb-session.0=abc; Path=/; HttpOnly; SameSite=Lax',
    'sb-session.1=def; Path=/; HttpOnly; SameSite=Lax',
    `dated=raw%2Fvalue; Path=/nested; Expires=${explicitExpires}`,
    'delete=gone; Path=/; Max-Age=0',
  ];
  const server = createServer((req, res) => {
    if (req.url === '/bytes') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'x-parity': 'binary-ok' });
      res.end(bytes);
    } else {
      res.writeHead(200, { 'Set-Cookie': cookies, 'Content-Type': 'text/html' });
      res.end('<main>synthetic cookie transport</main>');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-testerarmy-parity-'));
  const { chromium } = requireFromProduct('playwright');
  const native = await chromium.launch();
  try {
    const context = await native.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    const nativeCookies = await context.cookies();
    const nativeBytes = await page.evaluate(async () => {
      const response = await fetch('/bytes');
      return {
        bytes: [...new Uint8Array(await response.arrayBuffer())],
        status: response.status,
        header: response.headers.get('x-parity'),
      };
    });
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    mkdirSync(join(directory, 'testerarmy'));
    mkdirSync(join(directory, 'evidence/network'), { recursive: true });
    writeFileSync(
      join(directory, 'e2e.config.ts'),
      `
      import { web } from '@e2e-dev/web';
      import { testerArmyPreviewReporter } from ${JSON.stringify(join(root, 'scripts/lib/testerarmy-preview-reporter.mjs'))};
      export default { reporters:[testerArmyPreviewReporter(${JSON.stringify(join(directory, 'evidence'))})], targets:[{name:'product-authenticated',engine:web({headers:{'x-dayopt-e2e':'test'}}),app:{url:${JSON.stringify(origin)}}}], tests:['testerarmy/journey.e2e.ts'],trace:'off',video:'off',workers:1,retries:0 };
    `,
    );
    writeFileSync(
      join(directory, 'testerarmy/journey.e2e.ts'),
      `
      import { test } from '@e2e-dev/web';
      import { writeFileSync } from 'node:fs';
      import { forwardPreviewRequest } from ${JSON.stringify(join(root, 'scripts/runbook/testerarmy-preview-e2e.mjs'))};
      for(const index of [0,1,2]) test('synthetic parity '+index, async ({ app, browser }) => {
        const network=[];
        await browser.route('**/*', route => forwardPreviewRequest({
          route,browser,origin:${JSON.stringify(origin)},supabaseRef:'abcdefghijklmnopqrst',
          bypassSecret:'synthetic-only', privateDirectory:${JSON.stringify(directory)},network,
        }));
        await app.open('/');
        const cookies = await browser.cookies();
        const bytes = await browser.evaluate(async () => { const response=await fetch('/bytes'); return {bytes:[...new Uint8Array(await response.arrayBuffer())],status:response.status,header:response.headers.get('x-parity')}; });
        writeFileSync(${JSON.stringify(join(directory, 'evidence/network'))}+'/'+crypto.randomUUID()+'.json',JSON.stringify(network));
        writeFileSync(${JSON.stringify(join(directory, 'result.json'))}, JSON.stringify({ cookies,bytes }));
      });
    `,
    );
    let output = '';
    const exit = await new Promise<number>((done) => {
      const child = spawn(
        'pnpm',
        ['exec', 'e2e', 'run', '--config', join(directory, 'e2e.config.ts')],
        {
          cwd: root,
          env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        },
      );
      const deadline = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      }, 15_000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(deadline);
        done(1);
      });
      child.on('exit', (code) => {
        clearTimeout(deadline);
        done(code ?? 1);
      });
    });
    expect(exit, output).toBe(0);
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence/e2e.json'), 'utf8'));
    expect(evidence.status).toBe('passed');
    expect(evidence.tests).toHaveLength(3);
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    const normalize = (rows: Array<Record<string, unknown>>) =>
      rows
        .map(({ name, value, domain, path, httpOnly, secure, sameSite, expires }) => ({
          name,
          value,
          domain,
          path,
          httpOnly,
          secure,
          sameSite,
          expires: expires ?? -1,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(result.bytes).toEqual(nativeBytes);
    const observed = normalize(result.cookies);
    const nativeValues = normalize(nativeCookies);
    expect(observed.map(({ expires, ...rest }) => rest)).toEqual(
      nativeValues.map(({ expires, ...rest }) => rest),
    );
    for (let index = 0; index < observed.length; index++) {
      const expected = Number(nativeValues[index]!.expires);
      if (expected === -1) expect(observed[index]!.expires).toBe(-1);
      else expect(Math.abs(Number(observed[index]!.expires) - expected)).toBeLessThan(1);
    }
  } finally {
    await native.close();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
