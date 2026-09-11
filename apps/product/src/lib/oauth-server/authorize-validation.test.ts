import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateAuthorizeInput } from './authorize-validation';

const baseAuthorizeInput = {
  response_type: 'code',
  client_id: 'claude-ai',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
  scope: 'read:entries',
  resource: 'https://mcp.dayopt.app',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateAuthorizeInput redirect_uri allowlist', () => {
  it('accepts exact registered redirect URIs', () => {
    const result = validateAuthorizeInput(baseAuthorizeInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirectUri).toBe('https://claude.ai/api/mcp/auth_callback');
    }
  });

  it('rejects sibling HTTPS paths for ChatGPT', () => {
    const allowed = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'chatgpt',
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    });
    const siblingPath = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'chatgpt',
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect/extra',
    });
    const arbitraryPath = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'chatgpt',
      redirect_uri: 'https://chatgpt.com/anything',
    });

    expect(allowed.ok).toBe(true);
    expect(siblingPath).toEqual({ ok: false, error: 'invalid_redirect_uri' });
    expect(arbitraryPath).toEqual({ ok: false, error: 'invalid_redirect_uri' });
  });

  it('rejects arbitrary Cursor custom-scheme callbacks', () => {
    const allowed = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'cursor',
      redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
    });
    const siblingPath = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'cursor',
      redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback/extra',
    });
    const arbitraryCallback = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'cursor',
      redirect_uri: 'cursor://attacker.example/oauth/callback',
    });

    expect(allowed.ok).toBe(true);
    expect(siblingPath).toEqual({ ok: false, error: 'invalid_redirect_uri' });
    expect(arbitraryCallback).toEqual({ ok: false, error: 'invalid_redirect_uri' });
  });

  it('accepts configured ChatGPT redirect URIs by exact string only', () => {
    vi.stubEnv('OAUTH_CHATGPT_REDIRECT_URIS', 'https://chatgpt.com/connector/oauth/dayopt-prod');

    const configured = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'chatgpt',
      redirect_uri: 'https://chatgpt.com/connector/oauth/dayopt-prod',
    });
    const configuredSibling = validateAuthorizeInput({
      ...baseAuthorizeInput,
      client_id: 'chatgpt',
      redirect_uri: 'https://chatgpt.com/connector/oauth/dayopt-prod/extra',
    });

    expect(configured.ok).toBe(true);
    expect(configuredSibling).toEqual({ ok: false, error: 'invalid_redirect_uri' });
  });
});

describe('validateAuthorizeInput resource, PKCE, and scopes', () => {
  it('normalizes the configured protected resource', () => {
    const result = validateAuthorizeInput({
      ...baseAuthorizeInput,
      resource: 'HTTPS://MCP.DAYOPT.APP:443/',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resourceUri).toBe('https://mcp.dayopt.app');
  });

  it.each([undefined, 'https://mcp.dayopt.app/mcp', 'https://other.dayopt.app'])(
    'rejects a missing or mismatched resource: %s',
    (resource) => {
      expect(validateAuthorizeInput({ ...baseAuthorizeInput, resource })).toEqual({
        ok: false,
        error: 'invalid_resource',
      });
    },
  );

  it('rejects malformed PKCE challenges', () => {
    expect(validateAuthorizeInput({ ...baseAuthorizeInput, code_challenge: 'short' })).toEqual({
      ok: false,
      error: 'missing_pkce',
    });
  });

  it('rejects the entire request when any scope is unknown', () => {
    expect(
      validateAuthorizeInput({ ...baseAuthorizeInput, scope: 'read:entries unknown:scope' }),
    ).toEqual({ ok: false, error: 'invalid_scope' });
  });

  it('scope省略時はread:entriesだけをdefault grantにする', () => {
    const result = validateAuthorizeInput({ ...baseAuthorizeInput, scope: undefined });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['read:entries']);
  });

  // #1754: metadata が write 込みの全 scope を広告するようになったので、gate が閉じた
  // client も write を要求してくるのが正常系。ここで弾くと read-only の接続まで
  // 作れなくなるため、gate 判定は consent（resolveGrantableScopes）へ移した。
  it('write gate が閉じていても authorize は通し、付与の判断を consent へ渡す', () => {
    const closed = validateAuthorizeInput({
      ...baseAuthorizeInput,
      scope: 'read:entries write:plans',
    });

    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.scopes).toEqual(['read:entries', 'write:plans']);

    vi.stubEnv('MCP_WRITE_ENABLED_CLIENTS', 'chatgpt,claude-ai');
    const enabled = validateAuthorizeInput({
      ...baseAuthorizeInput,
      scope: 'read:entries write:plans',
    });

    expect(enabled.ok).toBe(true);
  });

  it('requires read:entries in every closed-beta write grant', () => {
    vi.stubEnv('MCP_WRITE_ENABLED_CLIENTS', 'chatgpt');

    expect(validateAuthorizeInput({ ...baseAuthorizeInput, scope: 'write:plans' })).toEqual({
      ok: false,
      error: 'invalid_scope',
    });
  });
});
