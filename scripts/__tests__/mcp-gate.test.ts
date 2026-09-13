import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMcpGate } from '../tasks/mcp-gate';

const env = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'isolated-test-key',
};
const target = ['--expect-url=http://127.0.0.1:54321', '--expect-environment=production'];
const control = {
  writes_enabled: false,
  billing_enforced: false,
  enabled_client_ids: [],
  revision: 4,
  changed_at: '2026-09-14T00:00:00Z',
};

function setup(identity = 'production', status = 200) {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([{ environment: identity }]))
    .mockResolvedValueOnce(Response.json([control]))
    .mockResolvedValueOnce(
      Response.json(
        status === 200 ? [{ ...control, revision: 5 }] : { message: 'private upstream error' },
        { status },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP gate operator boundary', () => {
  it('reads identity and control without calling a setter by default', async () => {
    const fetchMock = setup();
    await runMcpGate([], env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_mcp_environment_identity_v1`,
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/mcp_mutation_control?select=writes_enabled,billing_enforced,enabled_client_ids,revision,changed_at`,
    ]);
  });
  it.each([
    ['--enable-global'],
    [...target, '--expect-url=http://127.0.0.1:54321', '--enable-global'],
    [
      '--expect-url=https://wrong.supabase.co',
      '--expect-environment=production',
      '--enable-global',
    ],
    [...target, '--enable-global=false'],
    [...target, '--enable-global', '--disable-global'],
    [...target, '--enable-client=unknown'],
    [...target, '--typo'],
  ])('rejects unsafe arguments before any credentials leave the process: %j', async (...args) => {
    const fetchMock = setup();
    await expect(runMcpGate(args, env)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects missing credentials before network', async () => {
    const fetchMock = setup();
    await expect(runMcpGate([], {})).rejects.toThrow('NEXT_PUBLIC_SUPABASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses a different database identity before reading or changing control', async () => {
    const fetchMock = setup('preview');
    await expect(runMcpGate([...target, '--enable-global'], env)).rejects.toThrow('identity');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['--enable-global', 'set_mcp_mutation_control_v1', { p_writes_enabled: true }],
    ['--disable-global', 'set_mcp_mutation_control_v1', { p_writes_enabled: false }],
    [
      '--enable-client=claude-ai',
      'set_mcp_client_write_control_v1',
      { p_client_id: 'claude-ai', p_enabled: true },
    ],
    [
      '--disable-client=claude-ai',
      'set_mcp_client_write_control_v1',
      { p_client_id: 'claude-ai', p_enabled: false },
    ],
    ['--enable-billing', 'set_mcp_billing_enforcement_v1', { p_billing_enforced: true }],
    ['--disable-billing', 'set_mcp_billing_enforcement_v1', { p_billing_enforced: false }],
  ])('%s sends exactly one setter with the observed CAS revision', async (flag, rpc, payload) => {
    const fetchMock = setup();
    await runMcpGate([...target, flag], env);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${rpc}`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      ...payload,
      p_expected_revision: 4,
    });
    expect(fetchMock.mock.calls[2]?.[1]?.redirect).toBe('error');
  });
  it('does not retry a CAS failure or print the upstream response', async () => {
    const fetchMock = setup('production', 409);
    await expect(runMcpGate([...target, '--enable-global'], env)).rejects.toThrow('PostgREST 409');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('private upstream error'));
  });
});
