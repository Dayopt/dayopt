import { describe, expect, it } from 'vitest';

import { dayoptUrls } from '@dayopt/config';

import {
  assertProductDeploymentEnvironmentBuildEnv,
  assertProductIntegrationBuildEnv,
  assertProductOperationalProductionBuildEnv,
  assertProductPreviewBuildEnv,
  FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV,
  MCP_PRODUCTION_ORIGIN,
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_HOST,
  PRODUCT_INTEGRATION_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_HOST,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_PRODUCTION_ORIGIN,
  PRODUCT_VERCEL_PROJECT_ID,
  REQUIRED_PRODUCT_INTEGRATION_BUILD_ENV,
  REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV,
  REQUIRED_PRODUCT_PREVIEW_BUILD_ENV,
  resolveProductPublicMcpResourceUri,
} from './production-build-gate.mjs';

function completeProductionEnv() {
  return {
    VERCEL_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://isolated.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe-dummy-key',
    RESEND_API_KEY: 'safe-dummy-key',
    RESEND_FROM_EMAIL: 'noreply@dayopt.app',
    RESEND_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'safe-dummy-site-key',
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'safe-dummy-token',
    RECOVERY_CODE_PEPPER: 'safe-dummy-recovery-pepper',
    // 形式検査用 fixture。実在する鍵や本番の有効性を表さない。
    SUPABASE_SECRET_KEY: 'eyJ-safe-dummy-service-role-key',
  };
}

function completePreviewEnv() {
  const branchUrl = 'product-git-codex-mcp-preview-dayopt.vercel.app';
  return {
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    VERCEL_BRANCH_URL: branchUrl,
    VERCEL_GIT_COMMIT_REF: 'codex/mcp-preview',
    NEXT_PUBLIC_SUPABASE_URL: 'https://previewbranchref.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'safe-dummy-anon-key',
    SUPABASE_SECRET_KEY: 'safe-dummy-service-role-key',
    UPSTASH_REDIS_REST_URL: 'https://preview-example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'safe-dummy-upstash-token',
    RECOVERY_CODE_PEPPER: 'safe-dummy-recovery-pepper',
    MCP_OAUTH_ENVIRONMENT: 'preview',
    MCP_OAUTH_PREVIEW_BRANCH: 'codex/mcp-preview',
    MCP_OAUTH_PREVIEW_UPSTASH_HOST: 'preview-example.upstash.io',
    OAUTH_AUTHORIZATION_SERVER_URI: `https://${branchUrl}`,
    MCP_CANONICAL_RESOURCE_URI: `https://${branchUrl}`,
    NEXT_PUBLIC_APP_URL: `https://${branchUrl}`,
    MCP_WRITE_ENABLED_CLIENTS: '',
  };
}

function completeIntegrationEnv() {
  return {
    DAYOPT_ENVIRONMENT: 'integration',
    NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: 'integration',
    VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
    VERCEL_BRANCH_URL: PRODUCT_INTEGRATION_HOST,
    NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCT_INTEGRATION_SUPABASE_HOST}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe-dummy-key',
    SUPABASE_SECRET_KEY: 'eyJ-safe-dummy-service-role-key',
    NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_ORIGIN,
    MCP_OAUTH_ENVIRONMENT: 'integration',
    OAUTH_AUTHORIZATION_SERVER_URI: PRODUCT_INTEGRATION_ORIGIN,
    MCP_CANONICAL_RESOURCE_URI: PRODUCT_INTEGRATION_ORIGIN,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'safe-dummy-site-key',
    UPSTASH_REDIS_REST_URL: 'https://integration-example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'safe-dummy-upstash-token',
    RECOVERY_CODE_PEPPER: 'safe-dummy-recovery-pepper',
    MCP_WRITE_ENABLED_CLIENTS: '',
  };
}

describe('Product operational production build gate', () => {
  it('uses the shared canonical Product and MCP origins', () => {
    expect({
      productProduction: PRODUCT_PRODUCTION_ORIGIN,
      mcpProduction: MCP_PRODUCTION_ORIGIN,
    }).toEqual({
      productProduction: dayoptUrls.product,
      mcpProduction: dayoptUrls.mcp,
    });
  });

  it('skips Preview and non-Vercel CI', () => {
    expect(assertProductOperationalProductionBuildEnv({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(assertProductOperationalProductionBuildEnv({ CI: 'true' })).toBe(false);
  });

  it('does not let CI bypass a Vercel Production contract', () => {
    expect(() =>
      assertProductOperationalProductionBuildEnv({ VERCEL_ENV: 'production', CI: 'true' }),
    ).toThrow(
      `Product production build requires: ${REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV.join(', ')}`,
    );
  });

  // 必須 env を 1 つずつ落として、どれも単独で build を止めることを固定する。
  // 全欠落だけを見る test では、fixture 側に値を足した時に「実は誰も要求していない
  // env」が混ざっても気づけない（#1924 で Turnstile site key を足した際に顕在化）。
  it.each(REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV)('rejects a build missing only %s', (name) => {
    const env = completeProductionEnv();
    delete env[name];

    expect(() => assertProductOperationalProductionBuildEnv(env)).toThrow(
      `Product production build requires: ${name}`,
    );
  });

  // #2115: RECOVERY_CODE_PEPPER が production で「未設定」ではなく「空文字」のまま
  // 放置されていた。上の it.each は key を delete するだけなので、空文字という
  // 実際の故障形も別途固定する。
  it.each(REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV)(
    'rejects a build where %s is an empty string',
    (name) => {
      const env = { ...completeProductionEnv(), [name]: '' };

      expect(() => assertProductOperationalProductionBuildEnv(env)).toThrow(
        `Product production build requires: ${name}`,
      );
    },
  );

  it('rejects a non-Production identity on a Vercel Production deployment', () => {
    expect(() =>
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        MCP_OAUTH_ENVIRONMENT: 'staging',
      }),
    ).toThrow('Product production build cannot use a non-Production OAuth identity');
  });

  // Dayopt に staging 環境は無いが、あとから staging 名の custom environment が
  // 生えたときに Production の OAuth identity をそのまま配らないよう、sink ではなく
  // 明示的な拒否にしている。MCP 変数が 1 つも無くても止まることを固定する。
  it('rejects a staging deployment target even without MCP identity variables', () => {
    expect(() =>
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        VERCEL_TARGET_ENV: 'staging',
      }),
    ).toThrow('Product production build cannot use a non-Production OAuth identity');
  });

  it('accepts a Production deployment target with no MCP identity variables', () => {
    expect(
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        VERCEL_TARGET_ENV: 'production',
      }),
    ).toBe(true);
  });

  it('lists missing names without printing values', () => {
    expect(() => assertProductOperationalProductionBuildEnv({ VERCEL_ENV: 'production' })).toThrow(
      `Product production build requires: ${REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV.join(', ')}`,
    );
  });

  it.each(['contact-sender@dayopt.app', ' NoReply@Dayopt.App '])(
    'accepts an apex dayopt.app sender (%s)',
    (sender) => {
      expect(
        assertProductOperationalProductionBuildEnv({
          ...completeProductionEnv(),
          RESEND_FROM_EMAIL: sender,
        }),
      ).toBe(true);
    },
  );

  it.each([
    'onboarding@resend.dev',
    'sender@example.com',
    'sender@notdayopt.app',
    'sender@dayopt.app.example.com',
    'noreply@send.dayopt.app',
    'sender@.dayopt.app',
    'not-an-email',
  ])('rejects an invalid Resend sender (%s)', (sender) => {
    expect(() =>
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        RESEND_FROM_EMAIL: sender,
      }),
    ).toThrow('Product production build requires an apex dayopt.app RESEND_FROM_EMAIL');
  });

  it('rejects a Resend sender with a local part longer than 64 characters', () => {
    const oversizedSender = `${'a'.repeat(65)}@dayopt.app`;
    expect(() =>
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        RESEND_FROM_EMAIL: oversizedSender,
      }),
    ).toThrow('Product production build requires an apex dayopt.app RESEND_FROM_EMAIL');
  });

  it('rejects a malformed Upstash URL before build work starts', () => {
    expect(() =>
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        UPSTASH_REDIS_REST_URL: 'not-a-url',
      }),
    ).toThrow('Product production build requires a valid UPSTASH_REDIS_REST_URL');
  });

  it.each([
    'sb_secret_safe-dummy-value',
    'eyJ-safe-dummy-service-role-key',
    '  \\nsb_secret_safe-dummy-value\\n  ',
    '  \\neyJ-safe-dummy-service-role-key\\n  ',
  ])('accepts supported server key formats after env normalization: %s', (value) => {
    expect(
      assertProductOperationalProductionBuildEnv({
        ...completeProductionEnv(),
        SUPABASE_SECRET_KEY: value,
      }),
    ).toBe(true);
  });

  it.each(['sb_publishable_do-not-leak', 'not-a-key-do-not-leak', 'sb_secret_'])(
    'rejects an unsupported server key without disclosing it: %s',
    (value) => {
      let message = '';
      try {
        assertProductOperationalProductionBuildEnv({
          ...completeProductionEnv(),
          SUPABASE_SECRET_KEY: value,
        });
      } catch (error) {
        message = error.message;
      }
      expect(message).toContain('requires a server-only SUPABASE_SECRET_KEY');
      expect(message).not.toContain(value);
      expect(message).toContain('Verify password reauthentication');
    },
  );

  it.each([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ])('rejects deployment with missing or empty %s', (name) => {
    const env = completeProductionEnv();
    delete env[name];
    expect(() => assertProductOperationalProductionBuildEnv(env)).toThrow(name);
    env[name] = '  ';
    expect(() => assertProductOperationalProductionBuildEnv(env)).toThrow(name);
  });
});

describe('Product MCP Preview build gate', () => {
  it('skips generic Preview deployments without the explicit marker', () => {
    expect(
      assertProductPreviewBuildEnv({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        VERCEL_BRANCH_URL: 'product-git-other-dayopt.vercel.app',
      }),
    ).toBe(false);
  });

  it('accepts one isolated stable Preview branch identity', () => {
    expect(assertProductPreviewBuildEnv(completePreviewEnv())).toBe(true);
  });

  it('requires the complete Preview dependency set without printing values', () => {
    const missingNames = REQUIRED_PRODUCT_PREVIEW_BUILD_ENV.filter(
      (name) => name !== 'MCP_OAUTH_ENVIRONMENT',
    );
    expect(() =>
      assertProductPreviewBuildEnv({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        MCP_OAUTH_ENVIRONMENT: 'preview',
      }),
    ).toThrow(`Product MCP preview build requires: ${missingNames.join(', ')}`);
  });

  it('fails closed when only the Preview Upstash marker is configured', () => {
    expect(() =>
      assertProductPreviewBuildEnv({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        MCP_OAUTH_PREVIEW_UPSTASH_HOST: 'preview-example.upstash.io',
      }),
    ).toThrow('Product MCP preview build requires:');
  });

  it.each([
    ['VERCEL_GIT_COMMIT_REF', 'codex/other-branch'],
    ['VERCEL_TARGET_ENV', 'staging'],
    ['VERCEL_BRANCH_URL', 'product-a1b2c3-dayopt.vercel.app'],
    ['OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app'],
    ['MCP_CANONICAL_RESOURCE_URI', 'https://mcp.dayopt.app'],
    ['NEXT_PUBLIC_APP_URL', 'https://app.dayopt.app'],
    ['MCP_OAUTH_PREVIEW_UPSTASH_HOST', 'production-example.upstash.io'],
  ])('rejects Preview identity drift in %s', (name, value) => {
    expect(() =>
      assertProductPreviewBuildEnv({
        ...completePreviewEnv(),
        [name]: value,
      }),
    ).toThrow();
  });

  it('rejects the Production Supabase project', () => {
    expect(() =>
      assertProductPreviewBuildEnv({
        ...completePreviewEnv(),
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toThrow('Product MCP preview build requires a non-Production Supabase branch API origin');
  });

  it.each(FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV)(
    'rejects inherited Production-capable configuration: %s',
    (name) => {
      expect(() =>
        assertProductPreviewBuildEnv({
          ...completePreviewEnv(),
          [name]: 'must-not-be-printed',
        }),
      ).toThrow(`Product MCP preview build forbids: ${name}`);
    },
  );

  it('keeps all write clients disabled', () => {
    expect(() =>
      assertProductPreviewBuildEnv({
        ...completePreviewEnv(),
        MCP_WRITE_ENABLED_CLIENTS: 'chatgpt',
      }),
    ).toThrow('MCP_WRITE_ENABLED_CLIENTS to be empty');
  });
});

describe('Product Integration build gate', () => {
  it('skips builds that are not bound to the Integration project', () => {
    expect(assertProductIntegrationBuildEnv({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(assertProductIntegrationBuildEnv(completeProductionEnv())).toBe(false);
  });

  it('accepts the fixed Integration deployment and its non-production project', () => {
    expect(assertProductIntegrationBuildEnv(completeIntegrationEnv())).toBe(true);
    expect(assertProductOperationalProductionBuildEnv(completeIntegrationEnv())).toBe(false);
  });

  it('treats this project’s PR deployments as Preview, not as the fixed Integration app', () => {
    const previewEnv = {
      ...completePreviewEnv(),
      VERCEL_PROJECT_PRODUCTION_URL: PRODUCT_INTEGRATION_HOST,
    };

    expect(assertProductIntegrationBuildEnv(previewEnv)).toBe(false);
    expect(resolveProductPublicMcpResourceUri(previewEnv)).toBe(
      `https://${previewEnv.VERCEL_BRANCH_URL}`,
    );
  });

  it.each(REQUIRED_PRODUCT_INTEGRATION_BUILD_ENV)(
    'rejects an Integration build missing only %s',
    (name) => {
      const env = completeIntegrationEnv();
      delete env[name];
      expect(() => assertProductIntegrationBuildEnv(env)).toThrow(name);
    },
  );

  it.each([
    ['DAYOPT_ENVIRONMENT', 'production'],
    ['NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'preview'],
    ['VERCEL_TARGET_ENV', 'production'],
    ['VERCEL_GIT_COMMIT_REF', 'main'],
    ['VERCEL_PROJECT_ID', 'prj_not_product'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://yvglwblxrnrenfifsnje.supabase.co'],
    ['NEXT_PUBLIC_APP_URL', 'https://app.dayopt.app'],
    ['MCP_OAUTH_ENVIRONMENT', 'production'],
    ['OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app'],
  ])('rejects Integration identity drift in %s', (name, value) => {
    expect(() =>
      assertProductIntegrationBuildEnv({ ...completeIntegrationEnv(), [name]: value }),
    ).toThrow('Product Integration build requires its fixed domain');
  });

  it('fails closed for production-capable writes, billing, and analytics', () => {
    for (const [name, value, message] of [
      ['MCP_WRITE_ENABLED_CLIENTS', 'chatgpt', 'MCP_WRITE_ENABLED_CLIENTS to be empty'],
      ['BILLING_ENFORCED', 'true', 'BILLING_ENFORCED=true'],
      ['POSTHOG_SERVER_ENABLED', 'true', 'forbids PostHog event delivery'],
      ['NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'true', 'forbids PostHog event delivery'],
    ]) {
      expect(() =>
        assertProductIntegrationBuildEnv({ ...completeIntegrationEnv(), [name]: value }),
      ).toThrow(message);
    }
  });

  it.each([
    ['sk_' + 'live_live-secret', 'true'],
    ['rk_live_live-secret', 'false'],
    ['sk_' + 'test_safe-test-key', 'true'],
  ])('rejects a non-test Stripe configuration', (key, liveMode) => {
    expect(() =>
      assertProductIntegrationBuildEnv({
        ...completeIntegrationEnv(),
        STRIPE_SECRET_KEY: key,
        STRIPE_LIVEMODE: liveMode,
      }),
    ).toThrow('allows only Stripe test-mode credentials');
  });

  it('requires Integration Stripe API and webhook secrets as a pair', () => {
    expect(() =>
      assertProductIntegrationBuildEnv({
        ...completeIntegrationEnv(),
        STRIPE_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
      }),
    ).toThrow('Product Integration Stripe configuration requires all or none');

    expect(
      assertProductIntegrationBuildEnv({
        ...completeIntegrationEnv(),
        STRIPE_SECRET_KEY: 'sk_' + 'test_safe-test-key',
        STRIPE_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
        STRIPE_ACCOUNT_ID: 'acct_synthetic',
        STRIPE_LIVEMODE: 'false',
      }),
    ).toBe(true);
  });

  it.each(['noreply@dayopt.app', 'onboarding@resend.dev', 'sender@example.com'])(
    'rejects Integration Resend with complete configuration (%s)',
    (sender) => {
      expect(() =>
        assertProductIntegrationBuildEnv({
          ...completeIntegrationEnv(),
          RESEND_API_KEY: 'synthetic-mail-key',
          RESEND_FROM_EMAIL: sender,
          RESEND_WEBHOOK_SECRET: 'synthetic-webhook-key',
          CONTACT_INTEGRATION_RECIPIENT: 'qa@example.com',
        }),
      ).toThrow('Integration Resend delivery is not supported');
    },
  );
  it.each([
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'RESEND_WEBHOOK_SECRET',
    'CONTACT_INTEGRATION_RECIPIENT',
  ])('rejects partial Integration mail settings: %s', (name) => {
    expect(() =>
      assertProductIntegrationBuildEnv({
        ...completeIntegrationEnv(),
        [name]: 'synthetic-private-value',
      }),
    ).toThrow('Integration Resend delivery is not supported');
  });
  it.each([undefined, '', ' ', 'account_invalid', 'acct_'])(
    'rejects missing or malformed Stripe account identity: %s',
    (account) => {
      expect(() =>
        assertProductIntegrationBuildEnv({
          ...completeIntegrationEnv(),
          STRIPE_SECRET_KEY: 'sk_' + 'test_synthetic',
          STRIPE_WEBHOOK_SECRET: 'synthetic-webhook',
          STRIPE_LIVEMODE: 'false',
          STRIPE_ACCOUNT_ID: account,
        }),
      ).toThrow(/STRIPE_ACCOUNT_ID/);
    },
  );
  const calendarEnv = () => ({
    ...completeIntegrationEnv(),
    GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret',
    GOOGLE_CALENDAR_PROJECT_NUMBER: '123456',
    CALENDAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CALENDAR_REDIRECT_URIS: `${PRODUCT_INTEGRATION_ORIGIN}/api/integrations/google-calendar/callback`,
  });
  it('accepts a complete well-formed Calendar configuration', () => {
    expect(assertProductIntegrationBuildEnv(calendarEnv())).toBe(true);
  });
  it.each([
    ['GOOGLE_CALENDAR_PROJECT_NUMBER', '12345'],
    ['GOOGLE_CALENDAR_PROJECT_NUMBER', '012345'],
    ['GOOGLE_CALENDAR_PROJECT_NUMBER', 'x'.repeat(6)],
    ['GOOGLE_CALENDAR_PROJECT_NUMBER', '1'.repeat(31)],
    ['CALENDAR_TOKEN_ENCRYPTION_KEY', Buffer.alloc(31).toString('base64')],
    ['CALENDAR_TOKEN_ENCRYPTION_KEY', Buffer.alloc(33).toString('base64')],
    ['CALENDAR_TOKEN_ENCRYPTION_KEY', 'synthetic-private-invalid'],
  ])('rejects malformed Calendar %s without disclosing values', (name, value) => {
    try {
      assertProductIntegrationBuildEnv({ ...calendarEnv(), [name]: value });
      expect.fail('invalid Calendar configuration was accepted');
    } catch (error) {
      expect(error.message).toContain(name);
      expect(error.message).not.toContain(value);
    }
  });
});

describe('Product public MCP resource', () => {
  it('advertises only the resource owned by Production or the bound Preview', () => {
    expect(resolveProductPublicMcpResourceUri(completeProductionEnv())).toBe(MCP_PRODUCTION_ORIGIN);
    expect(resolveProductPublicMcpResourceUri(completePreviewEnv())).toBe(
      'https://product-git-codex-mcp-preview-dayopt.vercel.app',
    );
  });

  it.each([
    { VERCEL_ENV: 'preview' },
    { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' },
    { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'qa' },
    { VERCEL_ENV: 'development' },
  ])('does not advertise a fixed resource from an inactive Vercel environment', (env) => {
    expect(resolveProductPublicMcpResourceUri(env)).toBe('');
  });

  it('does not advertise the Production resource from local development', () => {
    // 旧挙動は Production URL を default にしていたが、これはローカル開発の
    // Settings を Production MCP への接続導線にしてしまう。ローカル build は
    // どの MCP resource も所有しないため、Preview と同じく何も advertise しない。
    expect(resolveProductPublicMcpResourceUri({})).toBe('');
  });

  it('advertises the Integration resource only for the exact Integration deployment', () => {
    expect(resolveProductPublicMcpResourceUri(completeIntegrationEnv())).toBe(
      PRODUCT_INTEGRATION_ORIGIN,
    );
    expect(
      resolveProductPublicMcpResourceUri({
        ...completeIntegrationEnv(),
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toBe('');
  });
});

function completeSharedPreviewEnv() {
  return {
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
    VERCEL_GIT_COMMIT_REF: 'codex/cloud-preview',
    VERCEL_BRANCH_URL: 'product-git-codex-cloud-preview-dayopt.vercel.app',
    VERCEL_URL: 'product-a1b2c3-dayopt.vercel.app',
    NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe-dummy-key',
    SUPABASE_SECRET_KEY: 'eyJ-safe-dummy-service-role-key',
    RECOVERY_CODE_PEPPER: 'safe-dummy-recovery-pepper',
  };
}

describe('Product deployment and Supabase binding', () => {
  it('accepts a Product Preview app connected to the persistent nonproduction Supabase project', () => {
    expect(assertProductDeploymentEnvironmentBuildEnv(completeSharedPreviewEnv())).toBe(true);
  });

  it('rejects Product Preview when it is built by a different Vercel project', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_PROJECT_ID: 'prj_not_product',
      }),
    ).toThrow('Product Preview build requires the Product Vercel project');
  });

  it('requires the complete Supabase pair and server key for Product Preview', () => {
    const env = completeSharedPreviewEnv();
    delete env.SUPABASE_SECRET_KEY;
    let message = '';
    try {
      assertProductDeploymentEnvironmentBuildEnv(env);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('SUPABASE_SECRET_KEY');
    expect(message).not.toContain('eyJ-safe-dummy-service-role-key');
  });

  it('rejects Production Supabase from a Preview app', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toThrow('forbids the Production Supabase project');
  });

  it('rejects fixed Integration identity or origin on a normal Preview app', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow('Product Integration build requires matching markers');
  });

  it('rejects an App URL that points outside the Preview deployment aliases', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow('NEXT_PUBLIC_APP_URL to match its Vercel URL');
  });

  it('rejects a path on a Preview App URL so callbacks remain on the deployment origin', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        NEXT_PUBLIC_APP_URL: 'https://product-git-codex-cloud-preview-dayopt.vercel.app/auth',
      }),
    ).toThrow('NEXT_PUBLIC_APP_URL to match its Vercel URL');
  });

  it('keeps shared Preview away from MCP OAuth authority, MCP writes, and billing enforcement', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        OAUTH_AUTHORIZATION_SERVER_URI: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow('cannot own an MCP OAuth identity');
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        MCP_WRITE_ENABLED_CLIENTS: 'chatgpt',
      }),
    ).toThrow('MCP_WRITE_ENABLED_CLIENTS to be empty');
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        BILLING_ENFORCED: 'true',
      }),
    ).toThrow('BILLING_ENFORCED=true');
  });

  it('allows Production Supabase only from the Production Vercel environment and main branch', () => {
    expect(
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeProductionEnv(),
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
        VERCEL_TARGET_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
      }),
    ).toBe(true);
  });

  it('rejects Production Supabase when Vercel does not identify the main branch', () => {
    const env = {
      ...completeProductionEnv(),
      NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
      VERCEL_TARGET_ENV: 'production',
    };
    expect(() => assertProductDeploymentEnvironmentBuildEnv(env)).toThrow(
      'reserved for the main Git branch',
    );
  });

  it('recognizes fixed Integration on the Product project integration branch Preview URL', () => {
    expect(
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
        VERCEL_GIT_COMMIT_REF: 'integration',
        VERCEL_BRANCH_URL: 'product-git-integration-dayopt.vercel.app',
        DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toBe(true);
  });

  it('rejects a fixed Integration identity when its generated branch URL drifts', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_GIT_COMMIT_REF: 'integration',
        VERCEL_BRANCH_URL: 'product-git-other-dayopt.vercel.app',
        DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow(
      'matching markers, Product project, integration branch, persistent Supabase ref, and fixed Vercel branch URL',
    );
  });

  it.each([
    {
      name: 'Vercel Project ID',
      overrides: { VERCEL_PROJECT_ID: 'prj_not_product' },
      expectedError: 'Product Preview build requires the Product Vercel project',
    },
    {
      name: 'Supabase project ref',
      overrides: { NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co' },
      expectedError:
        'matching markers, Product project, integration branch, persistent Supabase ref, and fixed Vercel branch URL',
    },
  ])('rejects fixed Integration when the $name drifts', ({ overrides, expectedError }) => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
        VERCEL_GIT_COMMIT_REF: 'integration',
        VERCEL_BRANCH_URL: 'product-git-integration-dayopt.vercel.app',
        DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
        ...overrides,
      }),
    ).toThrow(expectedError);
  });

  it('rejects the fixed Integration branch when Vercel marks it as Production', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'integration',
        VERCEL_BRANCH_URL: 'product-git-integration-dayopt.vercel.app',
        DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow('Product Production build requires its bound Production Supabase project');
  });

  it('rejects the Integration Git branch without both explicit Integration markers', () => {
    expect(() =>
      assertProductDeploymentEnvironmentBuildEnv({
        ...completeSharedPreviewEnv(),
        VERCEL_GIT_COMMIT_REF: 'integration',
        VERCEL_BRANCH_URL: 'product-git-integration-dayopt.vercel.app',
        NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
      }),
    ).toThrow(
      'matching markers, Product project, integration branch, persistent Supabase ref, and fixed Vercel branch URL',
    );
  });

  it('does not require Vercel settings for local builds and CI', () => {
    expect(assertProductDeploymentEnvironmentBuildEnv({ CI: 'true' })).toBe(false);
  });
});

// Synthetic JWTs only: classify public key formats without authenticating to Supabase.
function syntheticLegacyKey(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  return [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .concat(Buffer.alloc(32).toString('base64url'))
    .join('.');
}

function runProductBuildGates(env) {
  return [
    assertProductDeploymentEnvironmentBuildEnv,
    assertProductPreviewBuildEnv,
    assertProductIntegrationBuildEnv,
    assertProductOperationalProductionBuildEnv,
  ].map((gate) => gate(env));
}

describe('Product deployment credential boundary', () => {
  const anonKey = syntheticLegacyKey({ role: 'anon' });
  const invalidPublicKeys = [
    'sb_secret_do-not-leak',
    syntheticLegacyKey({ role: 'service_role' }),
    'not-a-key-do-not-leak',
    'sb_publishable_',
    'sb_publishable_invalid!characters',
    `sb_publishable_safe-dummy-key\n`,
    ` ${anonKey} `,
    `sb_publishable_safe-dummy-key\\n`,
    'eyJ-not-a-jwt',
    syntheticLegacyKey({ role: 'authenticated' }),
    syntheticLegacyKey({}),
    syntheticLegacyKey(null),
    syntheticLegacyKey({ role: 'anon' }, null),
    syntheticLegacyKey({ role: ['anon'] }),
    anonKey.replace(/[^.]+$/u, 'short'),
    `${anonKey}=`,
    syntheticLegacyKey({ role: 'anon' }, { alg: 'none', typ: 'JWT' }),
    `${anonKey}.extra`,
    anonKey.replace(/[^.]+$/u, ''),
    anonKey.replace(/[^.]+$/u, 'invalid!signature'),
    `${anonKey.split('.')[0]}.not-json.${anonKey.split('.')[2]}`,
  ];

  for (const [label, createEnv, expected] of [
    ['Preview', completeSharedPreviewEnv, [true, false, false, false]],
    ['Integration', completeIntegrationEnv, [true, false, true, false]],
    [
      'MCP Preview',
      () => ({
        ...completePreviewEnv(),
        VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
        NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_safe-dummy-key',
      }),
      [true, true, false, false],
    ],
    [
      'Production',
      () => ({
        ...completeProductionEnv(),
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
        VERCEL_GIT_COMMIT_REF: 'main',
      }),
      [true, false, false, true],
    ],
  ]) {
    it.each(['sb_publishable_safe-dummy-key', anonKey])(
      `accepts public key formats through the ${label} gate sequence: %s`,
      (value) => {
        expect(
          runProductBuildGates({
            ...createEnv(),
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: value,
          }),
        ).toEqual(expected);
      },
    );

    it.each(invalidPublicKeys)(
      `rejects unsafe public keys without disclosing values in ${label}: %s`,
      (value) => {
        let message = '';
        try {
          runProductBuildGates({ ...createEnv(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: value });
        } catch (error) {
          message = error.message;
        }
        expect(message).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
        expect(message).not.toContain(value);
        expect(message).not.toContain(value.trim());
      },
    );
  }

  it.each([undefined, '', '  ', '\n\t'])(
    'rejects missing or blank recovery pepper on ordinary Preview: %s',
    (value) => {
      const env = { ...completeSharedPreviewEnv(), RECOVERY_CODE_PEPPER: value };
      if (value === undefined) delete env.RECOVERY_CODE_PEPPER;
      expect(() => runProductBuildGates(env)).toThrow('RECOVERY_CODE_PEPPER');
    },
  );
});
