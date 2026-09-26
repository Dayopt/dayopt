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
  it('Previewだけにdeployment / 完全SHA / DB refを返す', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_preview123');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'a'.repeat(40));
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    expect(await GET().json()).toMatchObject({
      preview: {
        deploymentId: 'dpl_preview123',
        sha: 'a'.repeat(40),
        supabaseProjectRef: 'abcdefghijklmnopqrst',
      },
    });
  });

  it('本番ではPreview metadataを返さない', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await GET().json()).not.toHaveProperty('preview');
  });

  it('Preview設定が不正でもsecret入りの生URLを返さない', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://user:secret@example.com');
    const body = await GET().json();
    expect(body).toHaveProperty('preview', null);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
