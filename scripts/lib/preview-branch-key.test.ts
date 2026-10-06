import { describe, expect, it, vi } from 'vitest';

import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';
import { resolvePreviewSecretKey } from './preview-branch-key.mjs';

const projectRef = 'abcdefghijklmnopqrst';
const token = 'synthetic-management-token';

describe('resolvePreviewSecretKey', () => {
  it('requests and returns only the selected nonproduction project secret key', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json([
        { type: 'publishable', api_key: 'synthetic-publishable' },
        { type: 'secret', api_key: 'synthetic-target-secret' },
      ]),
    );

    await expect(
      resolvePreviewSecretKey({ projectRef, provisionToken: token, fetchImpl }),
    ).resolves.toBe('synthetic-target-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
    });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Bearer ${token}`,
    );
  });

  it('rejects Production and malformed project refs before making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolvePreviewSecretKey({
        projectRef: SUPABASE_PRODUCTION_PROJECT_REF,
        provisionToken: token,
        fetchImpl,
      }),
    ).rejects.toThrow('binding is invalid');
    await expect(
      resolvePreviewSecretKey({ projectRef: 'bad-ref', provisionToken: token, fetchImpl }),
    ).rejects.toThrow('binding is invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports only safe status metadata for permission errors', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('PRIVATE_TOKEN_BODY', { status: 403 }),
    );
    await expect(
      resolvePreviewSecretKey({ projectRef, provisionToken: token, fetchImpl }),
    ).rejects.toThrow('Preview target API key request failed (HTTP 403)');
    try {
      await resolvePreviewSecretKey({ projectRef, provisionToken: token, fetchImpl });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_TOKEN_BODY');
      expect(String(error)).not.toContain(token);
    }
  });

  it('rejects a missing or ambiguous target secret key without exposing response values', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json([
        { type: 'secret', api_key: 'synthetic-one' },
        { type: 'secret', api_key: 'synthetic-two' },
      ]),
    );
    await expect(
      resolvePreviewSecretKey({ projectRef, provisionToken: token, fetchImpl }),
    ).rejects.toThrow('unavailable or ambiguous');
  });
});
