import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
} from '@/lib/dayopt-environment';

import {
  assertDatabaseOAuthIdentity,
  DatabaseOAuthIdentityError,
  matchesDatabaseOAuthIdentity,
  resolveDatabaseOAuthProjectRef,
} from './database-identity';
import { resolveOAuthEnvironmentConfig } from './identity';

const productionIdentity = resolveOAuthEnvironmentConfig({});
const databaseProductionIdentity = {
  environment: 'production',
  authorization_server_uri: 'https://app.dayopt.app',
  resource_uri: 'https://mcp.dayopt.app',
  supabase_project_ref: null,
  provisioned_at: '2026-07-26T00:00:00.000Z',
};

const previewProjectRef = 'abcdefghijklmnopqrst';
const previewOrigin = 'https://product-git-codex-mcp-preview-dayopt.vercel.app';
const previewIdentity = resolveOAuthEnvironmentConfig({
  mcpOAuthEnvironment: 'preview',
  mcpOAuthPreviewBranch: 'codex/mcp-preview',
  authorizationServerUri: previewOrigin,
  resourceUri: previewOrigin,
  vercelEnvironment: 'preview',
  vercelTargetEnvironment: 'preview',
  vercelBranchUrl: 'product-git-codex-mcp-preview-dayopt.vercel.app',
  vercelGitCommitRef: 'codex/mcp-preview',
});
const databasePreviewIdentity = {
  environment: 'preview',
  authorization_server_uri: previewOrigin,
  resource_uri: previewOrigin,
  supabase_project_ref: previewProjectRef,
  provisioned_at: '2026-07-29T00:00:00.000Z',
};
const integrationIdentity = resolveOAuthEnvironmentConfig({
  mcpOAuthEnvironment: 'integration',
  dayoptEnvironment: 'integration',
  authorizationServerUri: PRODUCT_INTEGRATION_APP_ORIGIN,
  resourceUri: PRODUCT_INTEGRATION_APP_ORIGIN,
  vercelEnvironment: 'production',
  vercelTargetEnvironment: 'production',
  vercelGitCommitRef: 'integration',
  supabaseProjectRef: PRODUCT_INTEGRATION_SUPABASE_REF,
});
const databaseIntegrationIdentity = {
  environment: 'integration',
  authorization_server_uri: PRODUCT_INTEGRATION_APP_ORIGIN,
  resource_uri: PRODUCT_INTEGRATION_APP_ORIGIN,
  supabase_project_ref: PRODUCT_INTEGRATION_SUPABASE_REF,
  provisioned_at: '2026-09-27T00:00:00.000Z',
};

describe('database OAuth identity', () => {
  it('accepts the one exact deployment/database tuple', async () => {
    expect(matchesDatabaseOAuthIdentity(databaseProductionIdentity, productionIdentity)).toBe(true);

    await expect(
      assertDatabaseOAuthIdentity(productionIdentity, async () => ({
        data: [databaseProductionIdentity],
        error: null,
      })),
    ).resolves.toBeUndefined();
  });

  it('requires the exact Supabase project ref for a Preview tuple', async () => {
    expect(
      matchesDatabaseOAuthIdentity(databasePreviewIdentity, previewIdentity, previewProjectRef),
    ).toBe(true);

    await expect(
      assertDatabaseOAuthIdentity(
        previewIdentity,
        async () => ({ data: [databasePreviewIdentity], error: null }),
        previewProjectRef,
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertDatabaseOAuthIdentity(
        previewIdentity,
        async () => ({
          data: [
            {
              ...databasePreviewIdentity,
              supabase_project_ref: 'zyxwvutsrqponmlkjihg',
            },
          ],
          error: null,
        }),
        previewProjectRef,
      ),
    ).rejects.toBeInstanceOf(DatabaseOAuthIdentityError);
  });

  it.each([
    {
      name: 'missing row',
      data: [],
    },
    {
      name: 'duplicate rows',
      data: [databaseProductionIdentity, databaseProductionIdentity],
    },
    {
      name: 'environment mismatch',
      data: [{ ...databaseProductionIdentity, environment: 'staging' }],
    },
    {
      name: 'authorization server mismatch',
      data: [
        {
          ...databaseProductionIdentity,
          authorization_server_uri: 'https://staging.dayopt.app',
        },
      ],
    },
    {
      name: 'resource mismatch',
      data: [
        {
          ...databaseProductionIdentity,
          resource_uri: 'https://mcp.staging.dayopt.app',
        },
      ],
    },
  ])('rejects a $name without returning either tuple', async ({ data }) => {
    await expect(
      assertDatabaseOAuthIdentity(productionIdentity, async () => ({
        data,
        error: null,
      })),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DatabaseOAuthIdentityError>>({
        name: 'DatabaseOAuthIdentityError',
        message: 'Database OAuth identity is unavailable',
      }),
    );
  });

  it('preserves a query failure as the generic identity error cause', async () => {
    const queryError = new Error('database-message-sentinel');

    await expect(
      assertDatabaseOAuthIdentity(productionIdentity, async () => {
        throw queryError;
      }),
    ).rejects.toMatchObject({
      name: 'DatabaseOAuthIdentityError',
      cause: queryError,
    });
  });

  it('derives the expected Preview project from its API origin without decoding an API key', () => {
    expect(
      resolveDatabaseOAuthProjectRef({
        environment: 'preview',
        supabaseUrl: `https://${previewProjectRef}.supabase.co`,
      }),
    ).toBe(previewProjectRef);
  });

  it('binds Integration to its one persistent Supabase project ref', () => {
    expect(
      resolveDatabaseOAuthProjectRef({
        environment: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe(PRODUCT_INTEGRATION_SUPABASE_REF);

    expect(() =>
      resolveDatabaseOAuthProjectRef({
        environment: 'integration',
        supabaseUrl: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toThrow(DatabaseOAuthIdentityError);
  });

  it('requires an explicitly provisioned Integration identity and rechecks every request', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [databaseIntegrationIdentity], error: null })
      .mockResolvedValueOnce({
        data: [{ ...databaseIntegrationIdentity, resource_uri: 'https://other.example' }],
        error: null,
      });

    await expect(
      assertDatabaseOAuthIdentity(integrationIdentity, query, PRODUCT_INTEGRATION_SUPABASE_REF),
    ).rejects.toBeInstanceOf(DatabaseOAuthIdentityError);
    await expect(
      assertDatabaseOAuthIdentity(integrationIdentity, query, PRODUCT_INTEGRATION_SUPABASE_REF),
    ).resolves.toBeUndefined();
    await expect(
      assertDatabaseOAuthIdentity(integrationIdentity, query, PRODUCT_INTEGRATION_SUPABASE_REF),
    ).rejects.toBeInstanceOf(DatabaseOAuthIdentityError);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('refuses an Integration check against another project before querying', async () => {
    const query = vi.fn();
    await expect(
      assertDatabaseOAuthIdentity(integrationIdentity, query, previewProjectRef),
    ).rejects.toBeInstanceOf(DatabaseOAuthIdentityError);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'not-a-url',
    `http://${previewProjectRef}.supabase.co`,
    `https://${previewProjectRef}.supabase.co.attacker.example`,
    `https://${previewProjectRef}.supabase.co/path`,
    `https://user:password@${previewProjectRef}.supabase.co`,
    `https://${previewProjectRef}.supabase.co?project=other`,
  ])('rejects an invalid Preview API origin: %s', (supabaseUrl) => {
    expect(() => resolveDatabaseOAuthProjectRef({ environment: 'preview', supabaseUrl })).toThrow(
      DatabaseOAuthIdentityError,
    );
  });

  it('does not require a project ref for an established Production identity', () => {
    expect(
      resolveDatabaseOAuthProjectRef({ environment: 'production', supabaseUrl: undefined }),
    ).toBeNull();
  });
});
