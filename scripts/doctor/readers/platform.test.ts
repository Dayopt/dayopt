import { describe, expect, it, vi } from 'vitest';

import type { Observation, ReaderContext } from '../types.ts';
import { readPlatform } from './platform.ts';

const SECRET = 'fixture-secret-NEVER-EMIT-58fa';
const PII = 'fixture-private-user@example.invalid';
const MAIN = 'yvglwblxrnrenfifsnje';
const INTEGRATION = 'tilwaprottpyhlfoggbb';

function context(
  fixture: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>,
  environment: ReaderContext['environment'] = 'all',
) {
  const request = vi.fn(async (operation: string, params: Record<string, unknown> = {}) => {
    if (!(operation in fixture)) throw new Error(`Missing fixture: ${operation}`);
    const value = fixture[operation];
    return typeof value === 'function' ? value(params) : value;
  });
  const ctx: ReaderContext = { environment, root: '/fixture/dayopt', request };
  return { ctx, request };
}

function value(observations: Observation[], key: string) {
  const item = observations.find((row) => row.key === key);
  expect(item, key).toBeDefined();
  expect(item?.status, key).not.toBe('blocked');
  return item!.value;
}

function githubFixture(): Record<string, unknown> {
  return {
    'github.repository': {
      full_name: 'Dayopt/dayopt',
      visibility: 'public',
      default_branch: 'main',
      allow_merge_commit: true,
      token: SECRET,
      owner: { email: PII },
    },
    'github.rulesets': [
      {
        id: 123,
        name: 'main',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
        bypass_actors: [
          { actor_id: 2, actor_type: 'OrganizationAdmin', bypass_mode: 'always', secret: SECRET },
        ],
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: ['CI', 'Typecheck', 'Lint', 'Integration', 'Validation'].map(
                (name) => ({ context: name, integration_id: 15368, secret: SECRET }),
              ),
            },
          },
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_last_push_approval: true,
              required_review_thread_resolution: true,
              allowed_merge_methods: ['merge'],
              token: SECRET,
            },
          },
        ],
      },
    ],
    'github.environments': {
      environments: [
        {
          id: 5,
          name: 'production-release',
          protection_rules: [{ type: 'branch_policy' }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
        { id: 6, name: 'production-ops', protection_rules: [] },
        { id: 7, name: 'unrelated-personal-environment', protection_rules: [] },
      ],
    },
    'github.environment_secrets': {
      secrets: [{ name: 'VERCEL_TOKEN', value: SECRET, updated_at: 'now' }],
    },
    'github.workflows': {
      workflows: [
        {
          id: 8,
          name: 'Production Release',
          state: 'active',
          path: '.github/workflows/promote.yml',
          secret: SECRET,
        },
      ],
    },
    'github.repository_hooks': [
      {
        id: 9,
        active: true,
        name: 'web',
        events: ['push'],
        config: {
          url: `https://user:${SECRET}@hooks.example.invalid/deploy/${SECRET}?token=${SECRET}`,
          secret: SECRET,
        },
      },
    ],
  };
}

function vercelFixture(bindings: unknown[] = []): Record<string, unknown> {
  return {
    'vercel.project': (params: Record<string, unknown>) => ({
      name: params.project,
      id: `prj_${params.project}`,
      rootDirectory: `apps/${params.project}`,
      autoAssignCustomDomains: false,
      resourceConfig: { functionDefaultTimeout: 60 },
      protectionBypass: { [SECRET]: { scope: 'automation-bypass' } },
      passwordProtection: { password: SECRET },
      link: {
        type: 'github',
        org: 'Dayopt',
        repo: 'dayopt',
        productionBranch: 'main',
        token: SECRET,
      },
    }),
    'vercel.env': {
      envs: [
        {
          key: 'SUPABASE_SECRET_KEY',
          type: 'sensitive',
          target: ['preview'],
          gitBranch: 'integration',
          customEnvironmentIds: ['env_integration'],
          value: SECRET,
        },
      ],
    },
    'vercel.binding': bindings,
    'vercel.domains': { domains: [{ name: 'app.dayopt.app', verified: true, secret: SECRET }] },
    'vercel.deployments': {
      deployments: [
        {
          uid: 'dpl_product',
          url: `https://user:${SECRET}@product.example.invalid/?token=${SECRET}`,
          target: 'preview',
          readyState: 'READY',
          meta: { githubCommitSha: 'abc123', githubCommitRef: 'integration', token: SECRET },
        },
      ],
    },
  };
}

function supabaseFixture(): Record<string, unknown> {
  return {
    'supabase.branches': [
      { name: 'main', project_ref: MAIN, parent_project_ref: MAIN, is_default: true },
      { name: 'integration', project_ref: INTEGRATION, parent_project_ref: MAIN, persistent: true },
      {
        name: 'integration',
        project_ref: 'aaaaaaaaaaaaaaaaaaaa',
        parent_project_ref: 'unrelated-project',
      },
    ],
    'supabase.project': (params: Record<string, unknown>) => ({
      id: params.project_ref,
      name: 'dayopt',
      status: 'ACTIVE_HEALTHY',
      region: 'ap-northeast-1',
      secret: SECRET,
    }),
    'supabase.auth_config': {
      site_url: `https://user:${SECRET}@app.dayopt.app/?token=${SECRET}`,
      uri_allow_list: `https://app.dayopt.app/auth/callback?token=${SECRET},https://preview.example.invalid/auth/callback`,
      security_captcha_enabled: true,
      security_captcha_provider: 'turnstile',
      mfa_totp_verify_enabled: true,
      hook_send_email_secrets: SECRET,
      security_captcha_secret: SECRET,
      smtp_pass: SECRET,
      external_google_secret: SECRET,
      unknown_sensitive_field: SECRET,
    },
    'supabase.auth_audit': { passed: true, error_count: 0, error_body: SECRET },
    'supabase.functions': [
      {
        slug: 'send-auth-email',
        name: 'send-auth-email',
        verify_jwt: false,
        version: 4,
        secret: SECRET,
      },
    ],
    'supabase.backups': {
      pitr_enabled: true,
      region: 'ap-northeast-1',
      backups: [
        {
          status: 'COMPLETED',
          inserted_at: '2026-09-30',
          download_url: `https://example.invalid/${SECRET}`,
        },
      ],
      password: SECRET,
    },
    'supabase.database_metadata': [
      {
        migration_count: 200,
        latest_migration: '20260930000000',
        storage_rls_enabled: true,
        storage_rls_forced: false,
        mcp_control: {
          writes_enabled: true,
          billing_enforced: false,
          revision: 2,
          enabled_client_ids: ['claude-ai'],
          token: SECRET,
        },
        crons: [
          {
            jobname: 'cleanup-product-events',
            schedule: '40 3 * * *',
            active: true,
            command: SECRET,
          },
        ],
        buckets: [
          {
            id: 'avatars',
            public: true,
            file_size_limit: 5242880,
            allowed_mime_types: ['image/png'],
            owner: PII,
          },
        ],
        heartbeats: [
          {
            job_name: 'calendar-sync',
            last_started_at: 'now',
            last_completed_at: 'now',
            last_summary: { user_email: PII },
          },
        ],
        auth_users: [{ email: PII }],
        vault_decrypted_secrets: SECRET,
      },
    ],
  };
}

describe('platform readers (fixture request only)', () => {
  it('projects GitHub main ruleset checks, strictness, review/thread requirements and bypass metadata', async () => {
    const { ctx } = context(githubFixture());
    const observations = await readPlatform('github', ctx);
    const rulesets = value(observations, 'github.rulesets') as Array<{
      includes: string[];
      rules: Array<Record<string, unknown>>;
      bypass_actors: unknown[];
    }>;
    expect(rulesets[0].includes).toEqual(['refs/heads/main']);
    expect(rulesets[0].rules[0].strict_required_checks).toBe(true);
    expect(rulesets[0].rules[0].required_checks).toHaveLength(5);
    expect((rulesets[0].rules[0].required_checks as unknown[])[3]).toEqual({
      context: 'Integration',
      integration_id: 15368,
    });
    expect(rulesets[0].rules[1]).toMatchObject({
      required_review_count: 1,
      require_thread_resolution: true,
      require_last_push_approval: true,
      allowed_merge_methods: ['merge'],
    });
    expect(rulesets[0].bypass_actors).toEqual([
      { actor_id: 2, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
    ]);
    expect(JSON.stringify(observations)).not.toContain(SECRET);
    expect(JSON.stringify(observations)).not.toContain(PII);
  });

  it('reads secret names only from documented environments and redacts credential-bearing webhook paths', async () => {
    const { ctx, request } = context(githubFixture());
    const observations = await readPlatform('github', ctx);
    expect(value(observations, 'github.production-release.secret_names')).toEqual(['VERCEL_TOKEN']);
    expect(value(observations, 'github.repository_hooks')).toEqual([
      {
        id: 9,
        name: 'web',
        active: true,
        events: ['push'],
        destination_origin: 'https://hooks.example.invalid',
      },
    ]);
    const secretCalls = request.mock.calls.filter(
      ([operation]) => operation === 'github.environment_secrets',
    );
    expect(secretCalls.map(([, params]) => params?.environment)).toEqual([
      'production-release',
      'production-ops',
    ]);
  });

  it('marks one failed operation blocked and continues, exposing only safe error classification', async () => {
    const fixture = githubFixture();
    fixture['github.rulesets'] = () => {
      throw { code: 'FORBIDDEN', status: 403, message: SECRET, body: PII };
    };
    const { ctx, request } = context(fixture);
    const observations = await readPlatform('github', ctx);
    expect(observations.find((row) => row.key === 'github.rulesets')).toMatchObject({
      status: 'blocked',
      value: null,
    });
    expect(observations.find((row) => row.key === 'github.rulesets')?.reason).toContain('403');
    expect(value(observations, 'github.workflows')).toEqual([
      expect.objectContaining({ state: 'active' }),
    ]);
    expect(request.mock.calls.some(([operation]) => operation === 'github.repository_hooks')).toBe(
      true,
    );
    expect(JSON.stringify(observations)).not.toContain(SECRET);
    expect(JSON.stringify(observations)).not.toContain(PII);
  });

  it('fails a malformed GitHub ruleset response closed without treating a summary as details', async () => {
    const fixture = githubFixture();
    fixture['github.rulesets'] = [{ id: 1, name: 'main', enforcement: 'active' }];
    const observations = await readPlatform('github', context(fixture).ctx);
    expect(observations.find((row) => row.key === 'github.rulesets')?.status).toBe('blocked');
    expect(value(observations, 'github.repository')).toMatchObject({ default_branch: 'main' });
  });

  it('never traverses or emits Vercel protection bypass keys or environment values', async () => {
    const { ctx } = context(vercelFixture());
    const observations = await readPlatform('vercel', ctx);
    expect(value(observations, 'vercel.product.settings')).toMatchObject({
      id: 'prj_product',
      deployment_protection_configured: true,
    });
    expect(value(observations, 'vercel.product.environment_metadata')).toMatchObject({
      entries: [
        {
          key: 'SUPABASE_SECRET_KEY',
          type: 'sensitive',
          gitBranch: 'integration',
          targets: ['preview'],
          custom_environment_ids: ['env_integration'],
        },
      ],
    });
    expect(value(observations, 'vercel.product.deployments')).toEqual([
      expect.objectContaining({ url: 'https://product.example.invalid/', source_sha: 'abc123' }),
    ]);
    expect(JSON.stringify(observations)).not.toContain(SECRET);
  });

  it('projects Vercel bindings by approved types and secrets only by presence', async () => {
    const bindings = [
      {
        key: 'NEXT_PUBLIC_SUPABASE_URL',
        target: ['preview'],
        gitBranch: 'integration',
        value: `https://user:${SECRET}@${INTEGRATION}.supabase.co/?token=${SECRET}`,
      },
      { key: 'STRIPE_LIVEMODE', target: ['preview'], value: 'false' },
      { key: 'NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', target: ['preview'], value: true },
      { key: 'POSTHOG_SERVER_ENABLED', target: ['preview'], value: 'invalid' },
      { key: 'STRIPE_ACCOUNT_ID', target: ['preview'], value: 'acct_test' },
      { key: 'CALENDAR_TOKEN_ENCRYPTION_KEY', target: ['preview'], present: true, value: SECRET },
      { key: 'POSTHOG_PERSONAL_API_KEY', target: ['preview'], present: false, value: SECRET },
      {
        key: 'GOOGLE_CALENDAR_REDIRECT_URIS',
        target: ['preview'],
        value: `https://preview.example.invalid/api/integrations/google-calendar/callback?token=${SECRET}`,
      },
    ];
    const observations = await readPlatform('vercel', context(vercelFixture(bindings)).ctx);
    const projected = value(observations, 'vercel.product.public_bindings') as Array<
      Record<string, unknown>
    >;
    expect(projected.map((row) => row.value)).toEqual([
      null, // credential-bearing database URL is not accepted as a valid binding
      false,
      true,
      null,
      'acct_test',
      true,
      false,
      ['https://preview.example.invalid/api/integrations/google-calendar/callback'],
    ]);
    expect(projected[0]).toMatchObject({ target: ['preview'], gitBranch: 'integration' });
    expect(JSON.stringify(observations)).not.toContain(SECRET);
  });

  it('preserves origin-only bindings and does not hide a real trailing slash', async () => {
    const bindings = [
      {
        key: 'OAUTH_AUTHORIZATION_SERVER_URI',
        target: ['preview'],
        value: 'https://product-git-oauth-dayopt.vercel.app',
      },
      {
        key: 'NEXT_PUBLIC_APP_URL',
        target: ['preview'],
        value: 'https://product-git-oauth-dayopt.vercel.app/',
      },
    ];
    const observed = await readPlatform('vercel', context(vercelFixture(bindings)).ctx);
    expect(
      (value(observed, 'vercel.product.public_bindings') as Array<Record<string, unknown>>).map(
        (row) => row.value,
      ),
    ).toEqual(bindings.map((row) => row.value));
  });

  it('blocks unexpected Vercel binding keys and continues domains and the other project', async () => {
    const fixture = vercelFixture([{ key: 'UNEXPECTED_SECRET', value: SECRET }]);
    const observations = await readPlatform('vercel', context(fixture).ctx);
    expect(observations.find((row) => row.key === 'vercel.product.public_bindings')?.status).toBe(
      'blocked',
    );
    expect(value(observations, 'vercel.product.domains')).toEqual([
      expect.objectContaining({ verified: true }),
    ]);
    expect(value(observations, 'vercel.web.settings')).toMatchObject({ name: 'web' });
    expect(JSON.stringify(observations)).not.toContain(SECRET);
  });

  it('reads only current main and parent-bound Integration projects without arbitrary discovered project expansion', async () => {
    const { ctx, request } = context(supabaseFixture());
    const observations = await readPlatform('supabase', ctx);
    expect(value(observations, 'supabase.production.project')).toMatchObject({ id: MAIN });
    expect(value(observations, 'supabase.integration.project')).toMatchObject({ id: INTEGRATION });
    expect(
      request.mock.calls
        .filter(([operation]) => operation === 'supabase.project')
        .map(([, params]) => params?.project_ref),
    ).toEqual([MAIN, INTEGRATION]);
  });

  it('projects only safe Supabase Auth keys and safe audit summary, omitting hook/CAPTCHA/SMTP secrets', async () => {
    const observations = await readPlatform(
      'supabase',
      context(supabaseFixture(), 'production').ctx,
    );
    const auth = value(observations, 'supabase.production.auth_config') as Record<string, unknown>;
    expect(auth.security_captcha_enabled).toBe(true);
    expect(auth.mfa_totp_verify_enabled).toBe(true);
    expect(auth.hook_send_email_uri).toBeNull();
    expect(auth).not.toHaveProperty('hook_send_email_secrets');
    expect(auth).not.toHaveProperty('security_captcha_secret');
    expect(auth).not.toHaveProperty('smtp_pass');
    expect(auth).not.toHaveProperty('external_google_secret');
    expect(value(observations, 'supabase.production.auth_audit')).toEqual({
      passed: true,
      error_count: 0,
    });
    expect(JSON.stringify(observations)).not.toContain(SECRET);
  });

  it('projects fixed database metadata without PII, Vault, cron command or provider payload', async () => {
    const observations = await readPlatform(
      'supabase',
      context(supabaseFixture(), 'production').ctx,
    );
    const database = value(observations, 'supabase.production.database_metadata') as Array<{
      crons: Array<Record<string, unknown>>;
      heartbeats: Array<Record<string, unknown>>;
      [key: string]: unknown;
    }>;
    expect(database[0]).toMatchObject({
      migration_count: 200,
      storage_rls_enabled: true,
      mcp_control: { writes_enabled: true, enabled_client_ids: ['claude-ai'] },
      crons: [{ jobname: 'cleanup-product-events', schedule: '40 3 * * *', active: true }],
      buckets: [
        {
          id: 'avatars',
          public: true,
          file_size_limit: 5242880,
          allowed_mime_types: ['image/png'],
        },
      ],
    });
    expect(database[0]).not.toHaveProperty('auth_users');
    expect(database[0].crons[0]).not.toHaveProperty('command');
    expect(database[0].heartbeats[0]).not.toHaveProperty('last_summary');
    expect(JSON.stringify(observations)).not.toContain(SECRET);
    expect(JSON.stringify(observations)).not.toContain(PII);
  });

  it('isolates Supabase backup permission failure and does not publish error bodies', async () => {
    const fixture = supabaseFixture();
    fixture['supabase.backups'] = () => {
      throw { code: 'FORBIDDEN', status: 403, body: SECRET };
    };
    const observations = await readPlatform('supabase', context(fixture, 'production').ctx);
    expect(
      observations.find((row) => row.key === 'supabase.production.backup_metadata')?.status,
    ).toBe('blocked');
    expect(value(observations, 'supabase.production.database_metadata')).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain(SECRET);
  });

  it('marks unbound Preview selection manual and never queries its database', async () => {
    const { ctx, request } = context(supabaseFixture(), 'preview');
    const observations = await readPlatform('supabase', ctx);
    expect(
      observations.find((row) => row.key === 'supabase.preview_project_selection'),
    ).toMatchObject({ status: 'manual', value: null });
    expect(request.mock.calls.map(([operation]) => operation)).toEqual(['supabase.branches']);
  });
});
