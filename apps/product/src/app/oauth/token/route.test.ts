import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isWriteFenceEnabled: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled: mocks.isWriteFenceEnabled }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: vi.fn(() => ({})) }));

import { POST as compatPost } from '@/app/api/oauth/token/route';

import { POST, dynamic } from './route';

function createTokenRequest(url: string) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code' }).toString(),
  });
}

describe('canonical /oauth/token filesystem route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWriteFenceEnabled.mockResolvedValue(false);
  });

  it('shares the exact compat handler so both paths keep one contract', () => {
    // filesystem route 化で rewrite を外しても、`/api/oauth/token` 互換 path と
    // 実装が分岐しないことを固定する。
    expect(POST).toBe(compatPost);
    expect(dynamic).toBe('force-dynamic');
  });

  it('rejects an oversized form body before parsing it', async () => {
    // grant 種別の判定に body が要るため、body 読み取りは per-grant の上限より手前
    // （粗い IP 上限の内側）にある。無制限に読ませるとその頻度差が増幅になる。
    const oversized = new NextRequest('https://app.dayopt.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x'.repeat(20_000) }),
    });

    const response = await POST(oversized);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('write fence 中でも refresh は fence 判定へ入らない', async () => {
    // access token の寿命は 5 分。refresh を止めると fence が 5 分を超えた時点で
    // read-only 接続も失効し、「読み取りは通したまま」が MCP で成り立たなくなる。
    // refresh を通しても write の露出は増えない（MCP write は別 gate が持つ）。
    mocks.isWriteFenceEnabled.mockResolvedValue(true);

    const refresh = new NextRequest('https://app.dayopt.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'dop_rt_whatever',
        client_id: 'claude-ai',
        resource: 'https://mcp.dayopt.app',
      }),
    });

    const response = await POST(refresh);

    // fence の 503 ではなく、token 検証まで進んだ結果が返る。
    expect(mocks.isWriteFenceEnabled).not.toHaveBeenCalled();
    expect(response.status).not.toBe(503);
  });

  it('write fence 中は新規接続の作成を止める', async () => {
    mocks.isWriteFenceEnabled.mockResolvedValue(true);

    const authorizationCode = new NextRequest('https://app.dayopt.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code' }),
    });

    const response = await POST(authorizationCode);

    expect(mocks.isWriteFenceEnabled).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('rejects the MCP host now that the path resolves on every host', async () => {
    // rewrite 時代は mcp host に path 自体が無かった。filesystem route 化後は
    // handler 内の rejectUnexpectedOAuthHost が host 分離を担う。
    const response = await POST(createTokenRequest('https://mcp.dayopt.app/oauth/token'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });
});
