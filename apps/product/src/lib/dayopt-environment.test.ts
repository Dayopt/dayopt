import { describe, expect, it } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_PRODUCTION_SUPABASE_REF,
  PRODUCT_VERCEL_PROJECT_ID,
  resolveDayoptEnvironment,
  resolveSupabaseProjectRef,
} from './dayopt-environment';

describe('Dayopt app and database identity', () => {
  it('keeps an app Preview identity when it shares persistent Integration Supabase', () => {
    expect(
      resolveDayoptEnvironment({
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        vercelGitCommitRef: 'codex/cloud-preview',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe('preview');
  });

  it('recognizes the fixed Integration app only with its bound marker, branch, ref, and alias', () => {
    expect(
      resolveDayoptEnvironment({
        dayoptEnvironment: 'integration',
        publicDayoptEnvironment: 'integration',
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        vercelGitCommitRef: 'integration',
        vercelBranchUrl: 'product-git-integration-dayopt.vercel.app',
        appUrl: PRODUCT_INTEGRATION_APP_ORIGIN,
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe('integration');
  });

  it('recognizes Production only on the Production Vercel environment and Supabase project', () => {
    expect(
      resolveDayoptEnvironment({
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'main',
        supabaseUrl: `https://${PRODUCT_PRODUCTION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe('production');
  });

  it.each([
    {
      name: 'Preview is assigned to a different Vercel project',
      input: {
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelProjectId: 'prj_not_product',
        vercelGitCommitRef: 'codex/cloud-preview',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'Preview points to Production Supabase',
      input: {
        vercelEnvironment: 'preview',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        supabaseUrl: `https://${PRODUCT_PRODUCTION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'Integration ref is labelled as Production',
      input: {
        dayoptEnvironment: 'production',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'Integration ref is used by Preview with a fixed Integration URL',
      input: {
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        appUrl: PRODUCT_INTEGRATION_APP_ORIGIN,
        vercelBranchUrl: 'product-git-codex-cloud-preview-dayopt.vercel.app',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'Integration branch is missing its explicit app marker',
      input: {
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelProjectId: PRODUCT_VERCEL_PROJECT_ID,
        vercelGitCommitRef: 'integration',
        vercelBranchUrl: 'product-git-integration-dayopt.vercel.app',
        appUrl: PRODUCT_INTEGRATION_APP_ORIGIN,
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'Integration branch is assigned to a different Vercel project',
      input: {
        dayoptEnvironment: 'integration',
        publicDayoptEnvironment: 'integration',
        vercelEnvironment: 'preview',
        vercelProjectId: 'prj_not_product',
        vercelGitCommitRef: 'integration',
        vercelBranchUrl: 'product-git-integration-dayopt.vercel.app',
        appUrl: PRODUCT_INTEGRATION_APP_ORIGIN,
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'shared local connection is not explicit',
      input: { supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co` },
    },
    {
      name: 'server and browser markers disagree',
      input: {
        dayoptEnvironment: 'preview',
        publicDayoptEnvironment: 'integration',
        vercelEnvironment: 'preview',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
  ])('fails closed when $name', ({ input }) => {
    expect(resolveDayoptEnvironment(input)).toBe('unknown');
  });

  it('keeps local Supabase as the Local development fallback', () => {
    expect(resolveDayoptEnvironment({ supabaseUrl: 'http://127.0.0.1:54321' })).toBe('development');
  });

  it('allows an explicit local full-app connection to persistent Integration Supabase', () => {
    expect(
      resolveDayoptEnvironment({
        dayoptEnvironment: 'development',
        vercelEnvironment: 'development',
        vercelTargetEnvironment: 'development',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe('development');
  });

  it('extracts only canonical Supabase project refs', () => {
    expect(
      resolveSupabaseProjectRef(`https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`),
    ).toBe(PRODUCT_INTEGRATION_SUPABASE_REF);
    expect(
      resolveSupabaseProjectRef(
        `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co.evil.example`,
      ),
    ).toBeUndefined();
    expect(
      resolveSupabaseProjectRef(`http://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`),
    ).toBeUndefined();
  });
});
