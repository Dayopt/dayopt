import { describe, expect, it } from 'vitest';

import { evaluatePreviewPolicy } from './preview-policy.ts';
import type { Observation } from './types.ts';

const branch = 'mcp-check';
const branchHost = 'product-git-mcp-check-dayopt.vercel.app';
type Binding = { key: string; value: unknown; target: string[]; gitBranch: string | null };
function binding(key: string, value: unknown, scope: string | null = branch): Binding {
  return { key, value, target: ['preview'], gitBranch: scope };
}
function fixture(bindings: Binding[], extraMetadata: Binding[] = []): Observation[] {
  return [
    {
      key: 'vercel.product.public_bindings',
      environment: 'all',
      source: 'fixture',
      value: bindings,
    },
    {
      key: 'vercel.product.environment_metadata',
      environment: 'all',
      source: 'fixture',
      value: {
        entries: [...bindings, ...extraMetadata].map(({ key, target, gitBranch }) => ({
          key,
          targets: target,
          gitBranch,
          type: 'plain',
        })),
      },
    },
  ];
}
function valid(): Binding[] {
  return Object.entries({
    MCP_OAUTH_ENVIRONMENT: 'preview',
    MCP_OAUTH_PREVIEW_BRANCH: branch,
    MCP_OAUTH_PREVIEW_UPSTASH_HOST: 'preview-redis.upstash.io',
    OAUTH_AUTHORIZATION_SERVER_URI: `https://${branchHost}`,
    MCP_CANONICAL_RESOURCE_URI: `https://${branchHost}`,
    NEXT_PUBLIC_APP_URL: `https://${branchHost}`,
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    VERCEL_BRANCH_URL: branchHost,
    VERCEL_GIT_COMMIT_REF: branch,
    NEXT_PUBLIC_SUPABASE_URL: 'https://tilwaprottpyhlfoggbb.supabase.co/',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
    SUPABASE_SECRET_KEY: true,
    UPSTASH_REDIS_REST_URL: 'https://preview-redis.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: true,
    RECOVERY_CODE_PEPPER: true,
  }).map(([key, value]) => binding(key, value));
}
function rows(result: Observation) {
  return (
    result.value as {
      passed: boolean | null;
      branches: Array<{
        branch: string | null;
        status: string;
        failures: string[];
        unreadable: string[];
      }>;
    }
  ).branches;
}

describe('explicit MCP OAuth Preview policy', () => {
  it('reuses the existing gate with readable deployment/public values and secret presence placeholders', () => {
    const result = evaluatePreviewPolicy(fixture(valid()));
    expect(result.key).toBe('vercel.preview.mcp_build_policy');
    expect(result.environment).toBe('preview');
    expect(result.status).toBeUndefined();
    expect(result.value).toMatchObject({ passed: true });
    expect(rows(result).find((row) => row.branch === branch)).toEqual({
      branch,
      status: 'pass',
      failures: [],
      unreadable: [],
    });
    expect(JSON.stringify(result)).not.toContain('doctor-presence-placeholder');
  });

  it('keeps generic Preview and Integration not applicable when no explicit markers are configured', () => {
    const result = evaluatePreviewPolicy(
      fixture([
        binding(
          'NEXT_PUBLIC_SUPABASE_URL',
          'https://tilwaprottpyhlfoggbb.supabase.co/',
          'integration',
        ),
        binding('STRIPE_ACCOUNT_ID', 'acct_integration', 'integration'),
      ]),
    );
    expect(result.status).toBe('not_applicable');
    expect(rows(result).every((row) => row.status === 'not_applicable')).toBe(true);
  });

  it('blocks unreadable mandatory branch URL and Redis URL without synthesizing deployment values', () => {
    const bindings = valid().map((row) =>
      ['VERCEL_BRANCH_URL', 'UPSTASH_REDIS_REST_URL'].includes(row.key)
        ? { ...row, value: null }
        : row,
    );
    const result = evaluatePreviewPolicy(fixture(bindings));
    expect(result.status).toBe('blocked');
    expect(rows(result).find((row) => row.branch === branch)?.unreadable).toEqual(
      expect.arrayContaining(['VERCEL_BRANCH_URL', 'UPSTASH_REDIS_REST_URL']),
    );
    expect(result.value).toMatchObject({ passed: null });
  });

  it('reports a present but unreadable marker as blocked rather than not applicable', () => {
    const result = evaluatePreviewPolicy(fixture([binding('MCP_OAUTH_ENVIRONMENT', null)]));
    expect(result.status).toBe('blocked');
    expect(rows(result).find((row) => row.branch === branch)?.unreadable).toEqual([
      'MCP_OAUTH_ENVIRONMENT',
    ]);
  });

  it('reports Production DB reference and forbidden credentials as drift even if other values are unreadable', () => {
    const bindings = valid().map((row) =>
      row.key === 'NEXT_PUBLIC_SUPABASE_URL'
        ? { ...row, value: 'https://yvglwblxrnrenfifsnje.supabase.co/' }
        : row.key === 'VERCEL_BRANCH_URL'
          ? { ...row, value: null }
          : row,
    );
    bindings.push(
      binding('STRIPE_SECRET_KEY', true),
      binding('GOOGLE_CALENDAR_REDIRECT_URIS', [
        'https://app.dayopt.app/api/integrations/google-calendar/callback',
      ]),
    );
    const result = evaluatePreviewPolicy(fixture(bindings));
    expect(result.status).toBeUndefined();
    expect(result.value).toMatchObject({ passed: false });
    expect(rows(result).find((row) => row.branch === branch)?.failures).toEqual(
      expect.arrayContaining([
        'production_supabase_reference',
        'forbidden_present:STRIPE_SECRET_KEY',
        'forbidden_present:GOOGLE_CALENDAR_REDIRECT_URIS',
      ]),
    );
  });

  it('checks exact stable alias and Redis host through the existing build gate', () => {
    for (const [key, value] of [
      ['UPSTASH_REDIS_REST_URL', 'https://wrong-redis.upstash.io'],
      ['VERCEL_BRANCH_URL', 'random-deployment.vercel.app'],
      ['MCP_CANONICAL_RESOURCE_URI', 'https://mcp.dayopt.app'],
    ]) {
      const result = evaluatePreviewPolicy(
        fixture(valid().map((row) => (row.key === key ? { ...row, value } : row))),
      );
      expect(result.value).toMatchObject({ passed: false });
      expect(rows(result).find((row) => row.branch === branch)?.failures).toContain(
        'existing_preview_build_contract_rejected',
      );
    }
  });

  it('merges shared fallback with exact branch override without contaminating sibling branches', () => {
    const bindings = valid().map((row) =>
      row.key === 'NEXT_PUBLIC_SUPABASE_URL' ? { ...row, gitBranch: null } : row,
    );
    bindings.push(
      binding(
        'NEXT_PUBLIC_SUPABASE_URL',
        'https://yvglwblxrnrenfifsnje.supabase.co/',
        'unrelated-branch',
      ),
    );
    const result = evaluatePreviewPolicy(fixture(bindings));
    expect(result.value).toMatchObject({ passed: true });
    expect(rows(result).find((row) => row.branch === branch)?.status).toBe('pass');
    expect(rows(result).find((row) => row.branch === 'unrelated-branch')?.status).toBe(
      'not_applicable',
    );
  });

  it('blocks missing upstream observations and respects API permission failures', () => {
    expect(evaluatePreviewPolicy([]).status).toBe('blocked');
    const observations = fixture(valid());
    observations[0].status = 'blocked';
    observations[0].value = 'fixture-secret-DO-NOT-ECHO';
    const result = evaluatePreviewPolicy(observations);
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('fixture-secret-DO-NOT-ECHO');
  });

  it('rejects origin trailing slash and a conflicting production marker instead of normalizing them away', () => {
    const trailing = valid().map((row) =>
      row.key === 'MCP_CANONICAL_RESOURCE_URI' ? { ...row, value: `https://${branchHost}/` } : row,
    );
    expect(evaluatePreviewPolicy(fixture(trailing)).value).toMatchObject({ passed: false });
    const wrongMarker = valid().map((row) =>
      row.key === 'MCP_OAUTH_ENVIRONMENT' ? { ...row, value: 'production' } : row,
    );
    const result = evaluatePreviewPolicy(fixture(wrongMarker));
    expect(result.value).toMatchObject({ passed: false });
    expect(rows(result).find((row) => row.branch === branch)?.failures).toContain(
      'mcp_oauth_environment_not_preview',
    );
  });

  it('flags write/billing allowlists and required secret absence without reading secret values', () => {
    const bindings = valid().map((row) =>
      row.key === 'SUPABASE_SECRET_KEY' ? { ...row, value: false } : row,
    );
    bindings.push(
      binding('BILLING_ENFORCED', true),
      binding('MCP_WRITE_ENABLED_CLIENTS', 'claude-ai'),
    );
    const result = evaluatePreviewPolicy(fixture(bindings));
    expect(result.value).toMatchObject({ passed: false });
    expect(rows(result).find((row) => row.branch === branch)?.failures).toEqual(
      expect.arrayContaining([
        'billing_enforced_forbidden',
        'mcp_write_allowlist_forbidden',
        'required_absent:SUPABASE_SECRET_KEY',
      ]),
    );
  });
});
