import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { dayoptUrls } from '@dayopt/config';

import {
  assertProductDeploymentEnvironmentBuildEnv,
  assertProductOperationalProductionBuildEnv,
  assertProductPreviewBuildEnv,
  FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV,
  MCP_PRODUCTION_ORIGIN,
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_PRODUCTION_ORIGIN,
  PRODUCT_VERCEL_PROJECT_ID,
  REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV,
  REQUIRED_PRODUCT_PREVIEW_BUILD_ENV,
  resolveProductPublicMcpResourceUri,
} from './production-build-gate.mjs';
import {
  PRODUCT_INTEGRATION_APP_ORIGIN as RUNTIME_INTEGRATION_APP_ORIGIN,
  PRODUCT_VERCEL_PROJECT_ID as RUNTIME_PRODUCT_VERCEL_PROJECT_ID,
} from './src/lib/dayopt-environment';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

describe('Product deployment and Supabase identity build gate', () => {
  it('uses the same fixed Integration Project and origin at build time and runtime', () => {
    expect(PRODUCT_INTEGRATION_APP_ORIGIN).toBe(RUNTIME_INTEGRATION_APP_ORIGIN);
    expect(PRODUCT_VERCEL_PROJECT_ID).toBe(RUNTIME_PRODUCT_VERCEL_PROJECT_ID);
  });

  it('passes runtime identity and Supabase connection variables through Turbo strict mode', () => {
    const turbo = JSON.parse(readFileSync(resolve(repositoryRoot, 'turbo.json'), 'utf8'));
    const buildEnv = turbo.tasks.build.env;

    expect(buildEnv).toEqual(
      expect.arrayContaining([
        'DAYOPT_ENVIRONMENT',
        'NEXT_PUBLIC_APP_URL',
        'NEXT_PUBLIC_DAYOPT_ENVIRONMENT',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL',
        'SUPABASE_*',
        'VERCEL_PROJECT_ID',
      ]),
    );
  });

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
});
