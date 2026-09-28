import { describe, expect, it } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_VERCEL_PROJECT_ID,
} from '@/lib/dayopt-environment';

import { isOAuthRequestHostAllowed, resolveOAuthEnvironmentConfig } from './identity';

describe('MCP OAuth environment identity', () => {
  it('keeps the established Production identity as the local/default contract', () => {
    expect(resolveOAuthEnvironmentConfig({})).toEqual({
      environment: 'production',
      surfacesEnabled: true,
      authorizationServerUri: 'https://app.dayopt.app',
      authorizationServerHost: 'app.dayopt.app',
      authorizationEndpoint: 'https://app.dayopt.app/oauth/authorize',
      tokenEndpoint: 'https://app.dayopt.app/oauth/token',
      resourceUri: 'https://mcp.dayopt.app',
      resourceHost: 'mcp.dayopt.app',
      protectedResourceMetadataUri: 'https://mcp.dayopt.app/.well-known/oauth-protected-resource',
    });
  });

  it('normalizes the Production identity spelling before comparing it', () => {
    expect(
      resolveOAuthEnvironmentConfig({
        authorizationServerUri: 'HTTPS://APP.DAYOPT.APP:443/',
        resourceUri: 'https://MCP.DAYOPT.APP/',
      }).environment,
    ).toBe('production');
  });

  it.each([
    {
      name: 'staging marker is not an owned environment',
      input: { mcpOAuthEnvironment: 'staging' },
    },
    {
      name: 'staging identity values with a staging marker',
      input: {
        mcpOAuthEnvironment: 'staging',
        authorizationServerUri: 'https://staging.dayopt.app',
        resourceUri: 'https://mcp.staging.dayopt.app',
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'staging',
      },
    },
    {
      name: 'unknown marker',
      input: { mcpOAuthEnvironment: 'development' },
    },
    {
      name: 'foreign issuer in production',
      input: {
        authorizationServerUri: 'https://staging.dayopt.app',
        resourceUri: 'https://mcp.dayopt.app',
      },
    },
    {
      name: 'foreign resource in production',
      input: {
        authorizationServerUri: 'https://app.dayopt.app',
        resourceUri: 'https://mcp.staging.dayopt.app',
      },
    },
    {
      name: 'transport path in issuer',
      input: {
        authorizationServerUri: 'https://app.dayopt.app/oauth',
        resourceUri: 'https://mcp.dayopt.app',
      },
    },
    {
      name: 'preview branch marker without the preview environment',
      input: { mcpOAuthPreviewBranch: 'codex/mcp-preview' },
    },
    {
      name: 'preview marker on a Vercel Production deployment',
      input: {
        mcpOAuthEnvironment: 'preview',
        mcpOAuthPreviewBranch: 'codex/mcp-preview',
        authorizationServerUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        resourceUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelEnvironment: 'production',
        vercelBranchUrl: 'product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelGitCommitRef: 'codex/mcp-preview',
      },
    },
  ])('rejects identity drift: $name', ({ input }) => {
    expect(() => resolveOAuthEnvironmentConfig(input)).toThrow();
  });

  it('keeps the identity unavailable on a generic Vercel Preview', () => {
    expect(
      resolveOAuthEnvironmentConfig({
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
      }).surfacesEnabled,
    ).toBe(false);
  });

  it('accepts one explicitly bound stable Preview branch identity', () => {
    expect(
      resolveOAuthEnvironmentConfig({
        mcpOAuthEnvironment: 'preview',
        mcpOAuthPreviewBranch: 'codex/mcp-preview',
        authorizationServerUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        resourceUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelBranchUrl: 'product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelGitCommitRef: 'codex/mcp-preview',
      }),
    ).toEqual({
      environment: 'preview',
      surfacesEnabled: true,
      authorizationServerUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
      authorizationServerHost: 'product-git-codex-mcp-preview-dayopt.vercel.app',
      authorizationEndpoint:
        'https://product-git-codex-mcp-preview-dayopt.vercel.app/oauth/authorize',
      tokenEndpoint: 'https://product-git-codex-mcp-preview-dayopt.vercel.app/oauth/token',
      resourceUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
      resourceHost: 'product-git-codex-mcp-preview-dayopt.vercel.app',
      protectedResourceMetadataUri:
        'https://product-git-codex-mcp-preview-dayopt.vercel.app/.well-known/oauth-protected-resource',
    });
  });

  it('accepts one exact Integration identity on the integration Git branch and Supabase ref', () => {
    expect(
      resolveOAuthEnvironmentConfig({
        mcpOAuthEnvironment: 'integration',
        dayoptEnvironment: 'integration',
        publicDayoptEnvironment: 'integration',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        vercelBranchUrl: PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length),
        authorizationServerUri: PRODUCT_INTEGRATION_APP_ORIGIN,
        resourceUri: PRODUCT_INTEGRATION_APP_ORIGIN,
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelGitCommitRef: 'integration',
        supabaseProjectRef: PRODUCT_INTEGRATION_SUPABASE_REF,
      }),
    ).toMatchObject({
      environment: 'integration',
      surfacesEnabled: true,
      authorizationServerUri: PRODUCT_INTEGRATION_APP_ORIGIN,
      resourceUri: PRODUCT_INTEGRATION_APP_ORIGIN,
    });
  });

  it.each([
    {
      name: 'missing application marker',
      override: { dayoptEnvironment: undefined },
    },
    {
      name: 'Vercel Production environment',
      override: { vercelEnvironment: 'production' },
    },
    {
      name: 'Production Vercel target',
      override: { vercelTargetEnvironment: 'production' },
    },
    {
      name: 'main Git branch',
      override: { vercelGitCommitRef: 'main' },
    },
    {
      name: 'Production database ref',
      override: { supabaseProjectRef: 'yvglwblxrnrenfifsnje' },
    },
    {
      name: 'Production issuer',
      override: { authorizationServerUri: 'https://app.dayopt.app' },
    },
  ])('rejects Integration identity drift: $name', ({ override }) => {
    expect(() =>
      resolveOAuthEnvironmentConfig({
        mcpOAuthEnvironment: 'integration',
        dayoptEnvironment: 'integration',
        publicDayoptEnvironment: 'integration',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        vercelBranchUrl: PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length),
        authorizationServerUri: PRODUCT_INTEGRATION_APP_ORIGIN,
        resourceUri: PRODUCT_INTEGRATION_APP_ORIGIN,
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelGitCommitRef: 'integration',
        supabaseProjectRef: PRODUCT_INTEGRATION_SUPABASE_REF,
        ...override,
      }),
    ).toThrow();
  });

  it.each([
    {
      name: 'missing explicit branch',
      override: { mcpOAuthPreviewBranch: undefined },
    },
    {
      name: 'different deployed branch',
      override: { vercelGitCommitRef: 'codex/other-branch' },
    },
    {
      name: 'deployment URL instead of stable branch alias',
      override: { vercelBranchUrl: 'product-a1b2c3-dayopt.vercel.app' },
    },
    {
      name: 'staging target instead of standard Preview',
      override: { vercelTargetEnvironment: 'staging' },
    },
    {
      name: 'different resource origin',
      override: { resourceUri: 'https://mcp.dayopt.app' },
    },
  ])('rejects Preview identity drift: $name', ({ override }) => {
    expect(() =>
      resolveOAuthEnvironmentConfig({
        mcpOAuthEnvironment: 'preview',
        mcpOAuthPreviewBranch: 'codex/mcp-preview',
        authorizationServerUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        resourceUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelBranchUrl: 'product-git-codex-mcp-preview-dayopt.vercel.app',
        vercelGitCommitRef: 'codex/mcp-preview',
        ...override,
      }),
    ).toThrow();
  });
});

describe('MCP OAuth host boundary', () => {
  const productionIdentity = resolveOAuthEnvironmentConfig({});
  const previewIdentity = resolveOAuthEnvironmentConfig({
    mcpOAuthEnvironment: 'preview',
    mcpOAuthPreviewBranch: 'codex/mcp-preview',
    authorizationServerUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
    resourceUri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
    vercelEnvironment: 'preview',
    vercelTargetEnvironment: 'preview',
    vercelBranchUrl: 'product-git-codex-mcp-preview-dayopt.vercel.app',
    vercelGitCommitRef: 'codex/mcp-preview',
  });

  it.each([
    ['mcp.dayopt.app', '/'],
    ['mcp.dayopt.app', '/mcp'],
    ['mcp.dayopt.app', '/api/mcp'],
    ['mcp.dayopt.app', '/.well-known/oauth-protected-resource'],
    ['app.dayopt.app', '/oauth/authorize'],
    ['app.dayopt.app', '/oauth/consent'],
    ['app.dayopt.app', '/oauth/token'],
    ['app.dayopt.app', '/api/oauth/token'],
    ['app.dayopt.app', '/.well-known/oauth-authorization-server'],
    ['app.dayopt.app', '/calendar'],
  ])('allows the exact Production host/path pair: %s%s', (hostname, pathname) => {
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname,
        pathname,
        allowLocalDevelopment: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['app.dayopt.app', '/mcp'],
    ['app.dayopt.app', '/api/mcp'],
    ['app.dayopt.app', '/api/mcp/'],
    ['mcp.dayopt.app', '/oauth/token'],
    ['mcp.dayopt.app', '/api/oauth/token'],
    ['mcp.dayopt.app', '/calendar'],
    ['preview-product.vercel.app', '/api/mcp'],
    ['preview-product.vercel.app', '/oauth/authorize'],
    ['mcp.dayopt.app.example.com', '/mcp'],
    ['staging.dayopt.app', '/oauth/authorize'],
    ['mcp.staging.dayopt.app', '/mcp'],
  ])('rejects a cross-environment or foreign host/path pair: %s%s', (hostname, pathname) => {
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname,
        pathname,
        allowLocalDevelopment: false,
      }),
    ).toBe(false);
  });

  it('normalizes a trailing slash before applying the host boundary', () => {
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname: 'mcp.dayopt.app',
        pathname: '/api/mcp/',
        allowLocalDevelopment: false,
      }),
    ).toBe(true);
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname: 'preview-product.vercel.app',
        pathname: '/api/oauth/token/',
        allowLocalDevelopment: false,
      }),
    ).toBe(false);
  });

  it.each([
    '/oauth/authorize',
    '/oauth/token',
    '/.well-known/oauth-authorization-server',
    '/mcp',
    '/api/mcp',
    '/.well-known/oauth-protected-resource',
    '/calendar',
  ])('allows authorization, resource, and Product paths on the Preview origin: %s', (pathname) => {
    expect(
      isOAuthRequestHostAllowed({
        identity: previewIdentity,
        hostname: 'product-git-codex-mcp-preview-dayopt.vercel.app',
        pathname,
        allowLocalDevelopment: false,
      }),
    ).toBe(true);
  });

  it('rejects Production OAuth hosts while the Preview identity owns the surface', () => {
    for (const [hostname, pathname] of [
      ['app.dayopt.app', '/oauth/authorize'],
      ['mcp.dayopt.app', '/mcp'],
      ['mcp.dayopt.app', '/api/mcp'],
    ] as const) {
      expect(
        isOAuthRequestHostAllowed({
          identity: previewIdentity,
          hostname,
          pathname,
          allowLocalDevelopment: false,
        }),
      ).toBe(false);
    }
  });

  it('rejects Preview OAuth paths on deployment and similar-suffix hosts', () => {
    for (const hostname of [
      'product-a1b2c3-dayopt.vercel.app',
      'product-git-codex-mcp-preview-dayopt.vercel.app.example.com',
    ]) {
      expect(
        isOAuthRequestHostAllowed({
          identity: previewIdentity,
          hostname,
          pathname: '/oauth/authorize',
          allowLocalDevelopment: false,
        }),
      ).toBe(false);
    }
  });

  it('rejects all fixed OAuth hosts when a generic Preview is served on them', () => {
    const genericPreviewIdentity = resolveOAuthEnvironmentConfig({
      vercelEnvironment: 'preview',
      vercelTargetEnvironment: 'preview',
    });

    for (const [hostname, pathname] of [
      ['app.dayopt.app', '/oauth/authorize'],
      ['app.dayopt.app', '/calendar'],
      ['mcp.dayopt.app', '/'],
    ] as const) {
      expect(
        isOAuthRequestHostAllowed({
          identity: genericPreviewIdentity,
          hostname,
          pathname,
          allowLocalDevelopment: false,
        }),
      ).toBe(false);
    }
  });

  it('keeps local development available without allowing arbitrary Preview hosts', () => {
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname: 'localhost',
        pathname: '/api/mcp',
        allowLocalDevelopment: true,
      }),
    ).toBe(true);
    expect(
      isOAuthRequestHostAllowed({
        identity: productionIdentity,
        hostname: 'preview-product.vercel.app',
        pathname: '/api/mcp',
        allowLocalDevelopment: true,
      }),
    ).toBe(false);
  });
});
