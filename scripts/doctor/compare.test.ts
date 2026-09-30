import { describe, expect, it } from 'vitest';
import { compare, evaluate, evaluateBindings } from './compare';
import type { Definition, Observation } from './types';

const definition = (rule: string, expected: unknown = true): Definition => ({
  id: 'test.check',
  service: 'test',
  environments: ['all'],
  rule,
  expected,
  required: true,
  next_step: 'Inspect existing settings.',
});
const observation = (value: unknown, status?: Observation['status']): Observation => ({
  key: 'test.check',
  environment: 'production',
  value,
  source: 'fixture',
  ...(status ? { status } : {}),
});
const prodRef = 'yvglwblxrnrenfifsnje';
const pins = { production_ref: prodRef, test_account: 'acct_testFixture' };
const binding = (
  key: string,
  value: unknown,
  target = 'preview',
  gitBranch: string | null = 'integration',
) => ({ key, value, target: [target], gitBranch });
const production = binding(
  'NEXT_PUBLIC_SUPABASE_URL',
  `https://${prodRef}.supabase.co`,
  'production',
  null,
);
const checks = [
  '🔍 Static Checks',
  '📦 Unit Tests',
  '🧪 Integration Tests',
  'Vercel – product',
  'Vercel – web',
];
const ruleset = () => ({
  target: 'branch',
  enforcement: 'active',
  includes: ['refs/heads/main'],
  excludes: [],
  bypass_actors: [],
  rules: [
    {
      type: 'required_status_checks',
      strict_required_checks: true,
      required_checks: checks.map((context) => ({ context })),
    },
    { type: 'required_review_thread_resolution' },
  ],
});

describe('doctor comparisons', () => {
  it('keeps pass, drift, blocked and manual distinct', () => {
    expect(evaluate(definition('subset'), observation(true)).status).toBe('pass');
    expect(evaluate(definition('subset'), observation(false)).status).toBe('drift');
    expect(evaluate(definition('subset'), observation(true, 'blocked')).status).toBe('blocked');
    expect(evaluate(definition('subset'), observation(true, 'manual')).status).toBe('manual');
    expect(evaluate(definition('evidence'), observation(null)).status).toBe('blocked');
  });
  it('attaches deterministic provenance without treating metadata as runtime proof', () => {
    const result = compare(
      definition('evidence'),
      observation({ metadata: true }),
      new Date('2026-09-30T00:00:00Z'),
    );
    expect(result).toMatchObject({
      status: 'pass',
      checked_at: '2026-09-30T00:00:00.000Z',
      source: 'fixture',
      check_id: 'test.check:production',
    });
  });
  it('rejects a Production DB in Preview and preserves unreadable bindings as blocked', () => {
    expect(
      evaluateBindings(
        [production, binding('NEXT_PUBLIC_SUPABASE_URL', `https://${prodRef}.supabase.co`)],
        pins,
      ),
    ).toMatchObject({
      status: 'drift',
      reason: expect.stringContaining('production_database_in_preview'),
    });
    expect(
      evaluateBindings([production, binding('NEXT_PUBLIC_SUPABASE_URL', null)], pins).status,
    ).toBe('blocked');
  });
  it('requires deletion credential when either Preview analytics switch is enabled', () => {
    for (const key of ['POSTHOG_SERVER_ENABLED', 'NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED']) {
      expect(evaluateBindings([production, binding(key, true)], pins)).toMatchObject({
        status: 'drift',
        reason: expect.stringContaining('posthog_enabled_without_deletion_key'),
      });
      expect(
        evaluateBindings(
          [production, binding(key, true), binding('POSTHOG_PERSONAL_API_KEY', true)],
          pins,
        ).status,
      ).toBe('pass');
    }
  });
  it('requires deletion credentials for enabled Production analytics too', () => {
    expect(
      evaluateBindings(
        [production, binding('POSTHOG_SERVER_ENABLED', true, 'production', null)],
        pins,
      ),
    ).toMatchObject({
      status: 'drift',
      reason: expect.stringContaining('posthog_enabled_without_deletion_key'),
    });
  });
  it('does not require a deletion API key in the Web app, which has no deletion consumer', () => {
    expect(
      evaluateBindings([binding('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', true)], {
        ...pins,
        require_production_db: false,
        require_posthog_deletion: false,
      }).status,
    ).toBe('pass');
  });
  it('requires Integration billing mode/account and credential presence', () => {
    const valid = [
      production,
      binding('BILLING_ENFORCED', true),
      binding('STRIPE_LIVEMODE', false),
      binding('STRIPE_ACCOUNT_ID', pins.test_account),
      binding('STRIPE_SECRET_KEY', true),
      binding('STRIPE_WEBHOOK_SECRET', true),
    ];
    expect(evaluateBindings(valid, pins).status).toBe('pass');
    for (const key of [
      'STRIPE_LIVEMODE',
      'STRIPE_ACCOUNT_ID',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]) {
      const invalid = valid.map((row) =>
        row.key === key
          ? {
              ...row,
              value:
                key === 'STRIPE_LIVEMODE'
                  ? true
                  : key === 'STRIPE_ACCOUNT_ID'
                    ? 'acct_wrongFixture'
                    : false,
            }
          : row,
      );
      expect(evaluateBindings(invalid, pins).status).toBe('drift');
    }
    const unreadable = valid.map((row) =>
      row.key === 'STRIPE_ACCOUNT_ID' ? { ...row, value: null } : row,
    );
    expect(evaluateBindings(unreadable, pins).status).toBe('blocked');
  });
  it('requires Calendar encryption replica when a Calendar client is selected', () => {
    const configured = [
      production,
      binding('GOOGLE_CALENDAR_CLIENT_ID', 'fixture.apps.googleusercontent.com'),
    ];
    expect(evaluateBindings(configured, pins)).toMatchObject({
      status: 'drift',
      reason: expect.stringContaining('calendar_encryption_key_missing'),
    });
    expect(
      evaluateBindings([...configured, binding('CALENDAR_TOKEN_ENCRYPTION_KEY', true)], pins)
        .status,
    ).toBe('pass');
  });
  it('requires Production Calendar encryption replica too', () => {
    expect(
      evaluateBindings(
        [
          production,
          binding(
            'GOOGLE_CALENDAR_CLIENT_ID',
            'fixture.apps.googleusercontent.com',
            'production',
            null,
          ),
        ],
        pins,
      ),
    ).toMatchObject({
      status: 'drift',
      reason: expect.stringContaining('calendar_encryption_key_missing'),
    });
  });
  it('requires five checks, strict, thread resolution and no main bypass actors', () => {
    const def = definition('ruleset', { required_checks: checks });
    expect(evaluate(def, observation([ruleset()])).status).toBe('pass');
    const mutations = [
      { ...ruleset(), enforcement: 'disabled' },
      { ...ruleset(), includes: ['refs/heads/other'] },
      { ...ruleset(), excludes: ['refs/heads/main'] },
      { ...ruleset(), bypass_actors: [{ actor_id: 1 }] },
      { ...ruleset(), rules: [ruleset().rules[0]] },
      {
        ...ruleset(),
        rules: [{ ...ruleset().rules[0], strict_required_checks: false }, ruleset().rules[1]],
      },
      {
        ...ruleset(),
        rules: [
          {
            ...ruleset().rules[0],
            required_checks: checks.slice(0, 4).map((context) => ({ context })),
          },
          ruleset().rules[1],
        ],
      },
    ];
    for (const fixture of mutations)
      expect(evaluate(def, observation([fixture])).status).toBe('drift');
  });
});
