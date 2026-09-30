import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_VERCEL_PROJECT_ID,
} from '@/lib/dayopt-environment';

const integrationEnv: Record<string, string> = {
  NODE_ENV: 'production',
  VITEST: 'false',
  VERCEL_ENV: 'preview',
  VERCEL_TARGET_ENV: 'preview',
  VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
  VERCEL_BRANCH_URL: PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length),
  VERCEL_GIT_COMMIT_REF: 'integration',
  DAYOPT_ENVIRONMENT: 'integration',
  NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
  NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
  NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe-dummy-key',
  SUPABASE_SECRET_KEY: 'sb_secret_safe-dummy-key',
  RECOVERY_CODE_PEPPER: 'safe-dummy-recovery-pepper',
  UPSTASH_REDIS_REST_URL: 'https://integration-example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'safe-dummy-upstash-token',
};

async function loadIntegrationEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('CI', 'false');
  for (const [name, value] of Object.entries(integrationEnv)) {
    vi.stubEnv(name, value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value ?? '');
  }
  return await import('./env');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Integration server environment', () => {
  it('allows the exact fixed Integration binding without optional mail or Calendar credentials', async () => {
    const { env } = await loadIntegrationEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(
      `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
    );
  });

  it.each([
    ['DAYOPT_ENVIRONMENT', 'production'],
    ['NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'preview'],
    ['VERCEL_TARGET_ENV', 'production'],
    ['VERCEL_GIT_COMMIT_REF', 'main'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://yvglwblxrnrenfifsnje.supabase.co'],
    ['NEXT_PUBLIC_APP_URL', 'https://app.dayopt.app'],
  ])(
    'rejects Integration binding drift in %s without disclosing the value',
    async (name, value) => {
      const { env } = await loadIntegrationEnv({ [name]: value });
      let errorMessage = '';
      try {
        void env.NEXT_PUBLIC_SUPABASE_URL;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain('Product app environment must match');
      expect(errorMessage).not.toContain(value);
    },
  );

  it('logs only issue paths and codes when configuration validation fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = await loadIntegrationEnv({
      UPSTASH_REDIS_REST_URL: 'sensitive-invalid-url',
    });
    expect(() => env.NEXT_PUBLIC_SUPABASE_URL).toThrow('環境変数のバリデーション');
    expect(errorLog).toHaveBeenCalledWith('[env] validation failed', {
      issues: [{ path: 'UPSTASH_REDIS_REST_URL', code: 'invalid_string' }],
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('sensitive-invalid-url');
  });

  it('accepts a complete Integration-only Resend sink and rejects partial configuration', async () => {
    const complete = await loadIntegrationEnv({
      RESEND_API_KEY: 'safe-dummy-test-key',
      RESEND_FROM_EMAIL: 'noreply@dayopt.app',
      RESEND_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
      CONTACT_INTEGRATION_RECIPIENT: 'qa+integration@example.com',
    });
    expect(complete.env.NEXT_PUBLIC_SUPABASE_URL).toBe(
      `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
    );

    const partial = await loadIntegrationEnv({ RESEND_API_KEY: 'safe-dummy-test-key' });
    expect(() => partial.env.NEXT_PUBLIC_SUPABASE_URL).toThrow(
      'RESEND_API_KEY / apex dayopt.app RESEND_FROM_EMAIL / RESEND_WEBHOOK_SECRET',
    );
  });

  it('rejects Stripe live-mode credentials', async () => {
    const { env } = await loadIntegrationEnv({
      STRIPE_SECRET_KEY: 'sk_' + 'live_safe-dummy-key',
      STRIPE_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
      STRIPE_LIVEMODE: 'true',
    });
    expect(() => env.NEXT_PUBLIC_SUPABASE_URL).toThrow(
      'IntegrationではStripe test keyとSTRIPE_LIVEMODE=falseだけを使用してください',
    );
  });

  it('rejects a partial Stripe test configuration', async () => {
    const { env } = await loadIntegrationEnv({
      STRIPE_WEBHOOK_SECRET: 'safe-dummy-webhook-secret',
    });
    expect(() => env.NEXT_PUBLIC_SUPABASE_URL).toThrow(
      'IntegrationではStripe test keyとwebhook secretを一緒に設定してください',
    );
  });
});

describe('ordinary Preview Redis independence', () => {
  it.each(['tilwaprottpyhlfoggbb', 'abcdefghijklmnopqrst'])(
    'ignores unused malformed inherited Redis for %s at runtime',
    async (ref) => {
      const { env } = await loadIntegrationEnv({
        DAYOPT_ENVIRONMENT: 'preview',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'preview',
        VERCEL_GIT_COMMIT_REF: 'codex/example',
        VERCEL_URL: 'product-example-dayopt.vercel.app',
        VERCEL_BRANCH_URL: 'product-example-dayopt.vercel.app',
        NEXT_PUBLIC_APP_URL: 'https://product-example-dayopt.vercel.app',
        NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
        UPSTASH_REDIS_REST_URL: 'malformed',
        UPSTASH_REDIS_REST_TOKEN: '',
      });
      expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(`https://${ref}.supabase.co`);
    },
  );
});
