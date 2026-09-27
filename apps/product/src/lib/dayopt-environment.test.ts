import { describe, expect, it } from 'vitest';

import {
  PRODUCT_INTEGRATION_SUPABASE_REF,
  resolveDayoptEnvironment,
  resolveSupabaseProjectRef,
} from './dayopt-environment';

describe('Dayopt environment identity', () => {
  it('keeps Vercel target semantics as the fallback for existing environments', () => {
    expect(resolveDayoptEnvironment({ vercelEnvironment: 'production' })).toBe('production');
    expect(resolveDayoptEnvironment({ vercelEnvironment: 'preview' })).toBe('preview');
    expect(resolveDayoptEnvironment({})).toBe('development');
  });

  it('recognizes the persistent Integration project only with its explicit marker and DB ref', () => {
    expect(
      resolveDayoptEnvironment({
        dayoptEnvironment: 'integration',
        publicDayoptEnvironment: 'integration',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      }),
    ).toBe('integration');
  });

  it.each([
    {
      name: 'missing marker',
      input: {
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'production marker',
      input: {
        dayoptEnvironment: 'production',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'wrong platform target',
      input: {
        dayoptEnvironment: 'integration',
        vercelEnvironment: 'preview',
        vercelTargetEnvironment: 'preview',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'different git branch',
      input: {
        dayoptEnvironment: 'integration',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'main',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
    {
      name: 'different database',
      input: {
        dayoptEnvironment: 'integration',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: 'https://yvglwblxrnrenfifsnje.supabase.co',
      },
    },
    {
      name: 'server and browser markers disagree',
      input: {
        dayoptEnvironment: 'production',
        publicDayoptEnvironment: 'integration',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
      },
    },
  ])('fails closed for Integration drift: $name', ({ input }) => {
    expect(resolveDayoptEnvironment(input)).toBe('unknown');
  });

  it('does not accept an Integration marker on another Supabase project', () => {
    expect(
      resolveDayoptEnvironment({
        dayoptEnvironment: 'integration',
        vercelEnvironment: 'production',
        vercelTargetEnvironment: 'production',
        vercelGitCommitRef: 'integration',
        supabaseUrl: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toBe('unknown');
  });

  it('extracts only canonical Supabase project refs', () => {
    expect(resolveSupabaseProjectRef('https://yvglwblxrnrenfifsnje.supabase.co')).toBe(
      'yvglwblxrnrenfifsnje',
    );
    expect(resolveSupabaseProjectRef('http://yvglwblxrnrenfifsnje.supabase.co')).toBeUndefined();
    expect(
      resolveSupabaseProjectRef('https://yvglwblxrnrenfifsnje.supabase.co.evil.example'),
    ).toBeUndefined();
  });
});
