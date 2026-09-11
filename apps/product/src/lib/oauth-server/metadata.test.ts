import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from './metadata';

// 広告は SUPPORTED_SCOPES 全量。write は「この AS が理解する scope」の宣言であって
// 付与の約束ではない（実際の付与は consent の resolveGrantableScopes が決める）。
const ADVERTISED = [
  'read:entries',
  'read:activities',
  'read:constraints',
  'read:stats',
  'write:plans',
  'delete:plans',
  'write:records',
  'delete:records',
];

describe('OAuth metadata scopes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Production authorization server metadataの公開契約を固定する', () => {
    expect(buildAuthorizationServerMetadata()).toEqual({
      issuer: 'https://app.dayopt.app',
      authorization_endpoint: 'https://app.dayopt.app/oauth/authorize',
      token_endpoint: 'https://app.dayopt.app/oauth/token',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ADVERTISED,
    });
  });

  it('Production protected resource metadataの公開契約を固定する', () => {
    expect(buildProtectedResourceMetadata()).toEqual({
      resource: 'https://mcp.dayopt.app',
      authorization_servers: ['https://app.dayopt.app'],
      bearer_methods_supported: ['header'],
      scopes_supported: ADVERTISED,
    });
  });

  it('Preview metadataは束縛されたbranch originだけを広告する', () => {
    const previewOrigin = 'https://product-git-codex-mcp-preview-dayopt.vercel.app';
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'preview');
    vi.stubEnv('MCP_OAUTH_PREVIEW_BRANCH', 'codex/mcp-preview');
    vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', previewOrigin);
    vi.stubEnv('MCP_CANONICAL_RESOURCE_URI', previewOrigin);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_TARGET_ENV', 'preview');
    vi.stubEnv('VERCEL_BRANCH_URL', 'product-git-codex-mcp-preview-dayopt.vercel.app');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'codex/mcp-preview');

    expect(buildAuthorizationServerMetadata()).toMatchObject({
      issuer: previewOrigin,
      authorization_endpoint: `${previewOrigin}/oauth/authorize`,
      token_endpoint: `${previewOrigin}/oauth/token`,
    });
    expect(buildProtectedResourceMetadata()).toMatchObject({
      resource: previewOrigin,
      authorization_servers: [previewOrigin],
    });
  });

  it('MCP_OAUTH_ENVIRONMENTが不整合ならmetadata生成をthrowで止める', () => {
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'preview');

    expect(() => buildAuthorizationServerMetadata()).toThrow();
    expect(() => buildProtectedResourceMetadata()).toThrow();
  });
});
