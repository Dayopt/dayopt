import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

describe('GET /api/health/version', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ビルドの commit SHA（先頭 8 桁）を no-store で返す', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', 'abcdef1234567890');

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as { version: unknown; commitSha: unknown };
    expect(body.commitSha).toBe('abcdef12');
    expect(typeof body.version).toBe('string');
  });

  it('SHA を持たないビルドでは空文字を返す', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', '');

    const body = (await GET().json()) as { commitSha: unknown };

    expect(body.commitSha).toBe('');
  });
});
