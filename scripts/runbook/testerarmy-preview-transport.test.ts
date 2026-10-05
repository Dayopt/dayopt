import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { forwardPreviewRequest } from './testerarmy-preview-e2e.mjs';

const origin = 'https://product-synthetic-dayopt.vercel.app';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-army-transport-'));
  return {
    directory,
    options: {
      origin,
      supabaseRef: 'abcdefghijklmnopqrst',
      bypassSecret: 'synthetic-only',
      privateDirectory: directory,
      network: [],
      browser: { setCookies: vi.fn() },
      route: {
        request: { url: `${origin}/data`, method: 'GET', headers: {} },
        abort: vi.fn(),
        fulfill: vi.fn(),
      },
    },
  };
}

it('rejects declared and streamed oversized bodies before cookie installation or fulfillment', async () => {
  for (const response of [
    new Response('small', { headers: { 'content-length': '99', 'set-cookie': 'session=value' } }),
    new Response('too-large', { headers: { 'set-cookie': 'session=value' } }),
  ]) {
    const { directory, options } = setup();
    let signal: AbortSignal | null | undefined;
    try {
      await expect(
        forwardPreviewRequest({
          ...options,
          maxBytes: 5,
          fetchImpl: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            signal = init?.signal;
            return response;
          },
        }),
      ).rejects.toThrow('Response bound exceeded');
      expect(signal?.aborted).toBe(true);
      expect(options.browser.setCookies).not.toHaveBeenCalled();
      expect(options.route.fulfill).not.toHaveBeenCalled();
      expect(options.network).toEqual([]);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

it('fulfills a single redirect privately without following it and removes its binary file on failure', async () => {
  const { directory, options } = setup();
  const fetchImpl = vi.fn(
    async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(Buffer.from([0, 255, 128]), {
        status: 302,
        headers: {
          location: 'https://outside.invalid/redirect',
          'content-type': 'application/octet-stream',
        },
      }),
  );
  options.route.fulfill.mockImplementation(
    async (result: { path: string; status: number; headers: Record<string, string> }) => {
      expect(result.status).toBe(302);
      expect(result.headers.location).toBe('https://outside.invalid/redirect');
      expect(readFileSync(result.path)).toEqual(Buffer.from([0, 255, 128]));
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
      throw new Error('Synthetic browser fulfillment failed');
    },
  );
  try {
    await expect(forwardPreviewRequest({ ...options, fetchImpl })).rejects.toThrow(
      'Synthetic browser fulfillment failed',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${origin}/data`);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(options.network).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
