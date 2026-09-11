import { describe, expect, it } from 'vitest';

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
