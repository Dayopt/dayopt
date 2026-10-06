import { request, type APIRequestContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { publicFetchGet, publicRequestGet } from './public-get';

let origin: string;
let otherOrigin: string;
let server: Server;
let otherServer: Server;
let api: APIRequestContext;
let otherRequests = 0;

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  otherServer = createServer((_request, response) => {
    otherRequests += 1;
    response.end('Another origin received the request');
  });
  otherOrigin = await listen(otherServer);
  server = createServer((request, response) => {
    if (request.url === '/external-redirect') {
      response.writeHead(302, { location: `${otherOrigin}/destination` });
    } else if (request.url === '/local-redirect') {
      response.writeHead(308, { location: '/ok' });
    }
    response.end('Public content');
  });
  origin = await listen(server);
  api = await request.newContext();
});

beforeEach(() => {
  otherRequests = 0;
});

afterAll(async () => {
  await api?.dispose();
  for (const active of [server, otherServer]) {
    active?.closeAllConnections();
    await new Promise<void>((resolve) => active?.close(() => resolve()));
  }
});

it('Node GET rejects another origin before issuing a request', async () => {
  const failed = await publicFetchGet(`${otherOrigin}/direct`, origin).then(
    () => false,
    () => true,
  );
  expect({ failed, otherRequests }).toEqual({ failed: true, otherRequests: 0 });
});

it('Node GET refuses redirect delivery to another origin', async () => {
  const failed = await publicFetchGet('/external-redirect', origin).then(
    () => false,
    () => true,
  );
  expect({ failed, otherRequests }).toEqual({ failed: true, otherRequests: 0 });
});

it('Node GET uses GET, rejects redirects and applies the 15-second abort deadline', async () => {
  const observe = vi.spyOn(globalThis, 'fetch');
  const deadline = vi.spyOn(AbortSignal, 'timeout');
  try {
    const response = await publicFetchGet('/ok', origin);
    expect(await response.text()).toBe('Public content');
    expect(observe).toHaveBeenCalledWith(new URL('/ok', origin), {
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(deadline).toHaveBeenCalledWith(15_000);
  } finally {
    observe.mockRestore();
    deadline.mockRestore();
  }
});

it('API GET rejects another origin before issuing a request', async () => {
  const failed = await publicRequestGet(api, `${otherOrigin}/direct`, origin).then(
    () => false,
    () => true,
  );
  expect({ failed, otherRequests }).toEqual({ failed: true, otherRequests: 0 });
});

it('API GET prevents automatic delivery of an external redirect', async () => {
  const failed = await publicRequestGet(api, '/external-redirect', origin).then(
    () => false,
    () => true,
  );
  expect({ failed, otherRequests }).toEqual({ failed: true, otherRequests: 0 });
});

it('API GET follows a same-origin compatibility redirect with automatic redirects disabled', async () => {
  const observe = vi.spyOn(api, 'get');
  try {
    const response = await publicRequestGet(api, '/local-redirect', origin);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('Public content');
    expect(observe.mock.calls).toEqual([
      [new URL('/local-redirect', origin).href, { maxRedirects: 0, timeout: 15_000 }],
      [new URL('/ok', origin).href, { maxRedirects: 0, timeout: 15_000 }],
    ]);
    expect(otherRequests).toBe(0);
  } finally {
    observe.mockRestore();
  }
});
