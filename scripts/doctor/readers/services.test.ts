import assert from 'node:assert/strict';
import { it as test } from 'vitest';

import type { ReaderContext } from '../types.ts';
import { readService } from './services.ts';

const root = '/fixture/dayopt';
const fixtureSecret = 'whsec_DOCTOR_FIXTURE_MUST_NOT_ESCAPE';
const fixtureQuery = 'fixture_query_MUST_NOT_ESCAPE';
const fixtures: Record<string, unknown> = {
  'stripe.account': {
    id: 'acct_dayopt',
    charges_enabled: true,
    payouts_enabled: false,
    details_submitted: true,
    secret: fixtureSecret,
  },
  'stripe.listPrices': {
    data: [
      {
        id: 'price_dayopt',
        livemode: false,
        active: true,
        recurring: { interval: 'month' },
        product: 'prod_dayopt',
        secret: fixtureSecret,
      },
    ],
    has_more: false,
  },
  'stripe.listWebhooks': {
    data: [
      {
        id: 'we_dayopt',
        url: `https://app.dayopt.app/api/webhooks/stripe?bypass=${fixtureQuery}`,
        enabled_events: ['invoice.paid'],
        secret: fixtureSecret,
      },
      { id: 'we_other', url: 'https://unrelated.example/api/webhooks/stripe' },
    ],
    has_more: false,
  },
  'stripe.listPortalConfigurations': {
    data: [
      {
        id: 'bpc_dayopt',
        is_default: true,
        features: { subscription_cancel: { enabled: true } },
        default_return_url: `https://app.dayopt.app/settings/billing?secret=${fixtureQuery}`,
      },
    ],
    has_more: false,
  },
  'resend.listDomains': {
    data: [
      { id: 'domain_dayopt', name: 'dayopt.app' },
      { id: 'domain_other', name: 'unrelated.example' },
    ],
    has_more: false,
  },
  'resend.getDomain': {
    id: 'domain_dayopt',
    name: 'dayopt.app',
    status: 'verified',
    capabilities: { sending: 'enabled', receiving: 'disabled' },
    secret: fixtureSecret,
  },
  'resend.listWebhooks': {
    data: [
      {
        id: 'hook_dayopt',
        endpoint: `https://dayopt.app/api/webhooks/resend?secret=${fixtureQuery}`,
        events: ['email.bounced'],
        signing_secret: fixtureSecret,
      },
    ],
    has_more: false,
  },
  'cloudflare.listZones': {
    success: true,
    result: [{ id: 'zone_dayopt', name: 'dayopt.app', account: { id: 'account_dayopt' } }],
    result_info: { page: 1, total_pages: 1 },
  },
  'cloudflare.listTurnstile': {
    success: true,
    result: [{ name: 'Dayopt', domains: ['app.dayopt.app'], secret: fixtureSecret }],
    result_info: { page: 1, total_pages: 1 },
  },
  'cloudflare.listR2Buckets': {
    success: true,
    result: { buckets: [{ name: 'avatars' }, { name: 'attachments' }, { name: 'unrelated' }] },
  },
  'cloudflare.getR2Locks': {
    success: true,
    result: {
      rules: [
        { id: 'retention', enabled: true, condition: { type: 'Age', maxAgeSeconds: 3024000 } },
      ],
    },
  },
  'sentry.listProjects': [
    { id: 'project_dayopt', slug: 'dayopt' },
    { id: 'project_other', slug: 'unrelated' },
  ],
  'sentry.listReleases': [
    { version: 'a'.repeat(40), dateCreated: '2026-09-30T00:00:00Z', secret: fixtureSecret },
  ],
  'sentry.listReleaseFiles': [
    { id: 'file_dayopt', name: fixtureSecret, headers: { Authorization: fixtureSecret } },
  ],
  'posthog.getProject': {
    id: 625917,
    name: 'Dayopt',
    api_token: fixtureSecret,
    session_recording_opt_in: false,
  },
  'posthog.aggregate': [
    {
      environment: 'production',
      count: 4,
      email: 'fixture-private@example.invalid',
      distinct_id: fixtureSecret,
    },
  ],
  'upstash.ping': { result: 'PONG', token: fixtureSecret },
  'uptimerobot.getMonitors': {
    stat: 'ok',
    pagination: { total: 2 },
    monitors: [
      {
        id: 1,
        url: `https://app.dayopt.app/api/health?secret=${fixtureQuery}`,
        status: 2,
        interval: 300,
      },
      { id: 2, url: 'https://unrelated.example/health' },
    ],
  },
};

function context(
  overrides: Record<string, unknown> = {},
  environment: ReaderContext['environment'] = 'all',
) {
  const calls: { operation: string; params: Record<string, unknown> }[] = [];
  const ctx: ReaderContext = {
    root,
    environment,
    async request(operation, params = {}) {
      calls.push({ operation, params });
      const value = Object.hasOwn(overrides, operation)
        ? overrides[operation]
        : fixtures[operation];
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(params);
      assert.notEqual(value, undefined, `Unexpected fixture operation ${operation}`);
      return value;
    },
  };
  return { ctx, calls };
}

for (const [service, operations] of Object.entries({
  stripe: [
    'stripe.account',
    'stripe.listPrices',
    'stripe.listWebhooks',
    'stripe.listPortalConfigurations',
  ],
  resend: ['resend.listDomains', 'resend.getDomain', 'resend.listWebhooks'],
  cloudflare: [
    'cloudflare.listZones',
    'cloudflare.listTurnstile',
    'cloudflare.listR2Buckets',
    'cloudflare.getR2Locks',
  ],
  sentry: ['sentry.listProjects', 'sentry.listReleases', 'sentry.listReleaseFiles'],
  posthog: ['posthog.getProject', 'posthog.aggregate'],
  upstash: ['upstash.ping'],
  uptimerobot: ['uptimerobot.getMonitors'],
})) {
  test(`${service}: invokes reader operations and removes secret/PII/query fields`, async () => {
    const { ctx, calls } = context();
    const output = await readService(service, ctx);
    for (const operation of operations)
      assert.ok(
        calls.some((call) => call.operation === operation),
        operation,
      );
    assert.ok(output.length > 0);
    const serialized = JSON.stringify(output);
    assert.ok(!serialized.includes(fixtureSecret));
    assert.ok(!serialized.includes(fixtureQuery));
    assert.ok(!serialized.includes('fixture-private@example.invalid'));
    if (service !== 'stripe' && service !== 'resend')
      assert.ok(!serialized.includes('unrelated.example'));
  });
}

test('Stripe production scope never invokes test-mode operations', async () => {
  const { ctx, calls } = context({}, 'production');
  await readService('stripe', ctx);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.params.mode === 'live'));
});

test('Cloudflare derives account ID only from the Dayopt zone', async () => {
  const { ctx, calls } = context();
  await readService('cloudflare', ctx);
  const accountCalls = calls.filter((call) => call.operation !== 'cloudflare.listZones');
  assert.ok(accountCalls.length > 0);
  assert.ok(accountCalls.every((call) => call.params.account_id === 'account_dayopt'));
});

for (const status of [403, 404]) {
  test(`HTTP ${status} blocks one operation and continues independent operations`, async () => {
    const error = Object.assign(new Error(`https://secret.example/${fixtureSecret}`), { status });
    const { ctx, calls } = context({ 'stripe.listPrices': error }, 'integration');
    const output = await readService('stripe', ctx);
    const failed = output.find((row) => row.key === 'stripe.active_prices');
    assert.equal(failed?.status, 'blocked');
    assert.equal(failed?.value, null);
    assert.equal(
      failed?.reason,
      status === 403 ? 'insufficient_access' : 'resource_not_accessible',
    );
    assert.ok(calls.some((call) => call.operation === 'stripe.listWebhooks'));
    assert.ok(calls.some((call) => call.operation === 'stripe.listPortalConfigurations'));
    assert.ok(!JSON.stringify(output).includes(fixtureSecret));
  });
}

test('PostHog settings 403 does not prevent the fixed aggregate read', async () => {
  const { ctx, calls } = context({
    'posthog.getProject': Object.assign(new Error(fixtureSecret), { status: 403 }),
  });
  const output = await readService('posthog', ctx);
  assert.equal(output.find((row) => row.key === 'posthog.settings')?.status, 'blocked');
  assert.ok(calls.some((call) => call.operation === 'posthog.aggregate'));
  assert.deepEqual(output.find((row) => row.key === 'posthog.ingestion_aggregate')?.value, [
    { environment: 'production', count: 4 },
  ]);
});

for (const [service, operation, key] of [
  ['stripe', 'stripe.listPrices', 'stripe.active_prices'],
  ['resend', 'resend.listDomains', 'resend.domains'],
] as const) {
  test(`${service}: pagination failure reports unknown instead of complete absence`, async () => {
    let count = 0;
    const { ctx, calls } = context(
      {
        [operation]: () => {
          count += 1;
          if (count === 1)
            return { data: [{ id: 'fixture_page_one', name: 'dayopt.app' }], has_more: true };
          throw Object.assign(new Error(fixtureSecret), { status: 403 });
        },
      },
      'integration',
    );
    const output = await readService(service, ctx);
    const observation = output.find((row) => row.key === key);
    assert.equal(observation?.status, 'blocked');
    assert.equal(observation?.value, null);
    const pages = calls.filter((call) => call.operation === operation);
    assert.equal(pages.length, 2);
    assert.equal(
      pages[1]?.params[service === 'stripe' ? 'starting_after' : 'after'],
      'fixture_page_one',
    );
  });
}

test('URL userinfo is never projected', async () => {
  const { ctx } = context(
    {
      'stripe.listWebhooks': {
        data: [
          {
            id: 'fixture_userinfo',
            url: `https://user:${fixtureSecret}@app.dayopt.app/api/webhooks/stripe`,
          },
        ],
        has_more: false,
      },
    },
    'integration',
  );
  const output = await readService('stripe', ctx);
  assert.ok(!JSON.stringify(output).includes(fixtureSecret));
});

for (const [service, operation, key, urlField] of [
  ['stripe', 'stripe.listWebhooks', 'stripe.webhooks', 'url'],
  ['resend', 'resend.listWebhooks', 'resend.webhooks', 'endpoint'],
] as const) {
  test(`${service}: account-scoped unexpected webhook origin is visible without credentials`, async () => {
    const { ctx } = context(
      {
        [operation]: {
          data: [
            {
              id: 'fixture_unexpected',
              [urlField]: `https://unexpected.example/api/webhooks/${service}?credential=${fixtureQuery}`,
              secret: fixtureSecret,
            },
          ],
          has_more: false,
        },
      },
      'integration',
    );
    const output = await readService(service, ctx);
    const webhook = output.find((row) => row.key === key);
    assert.ok(JSON.stringify(webhook?.value).includes('https://unexpected.example'));
    assert.ok(!JSON.stringify(output).includes(fixtureQuery));
    assert.ok(!JSON.stringify(output).includes(fixtureSecret));
  });
}

test('URL arbitrary paths cannot expose embedded credentials', async () => {
  const { ctx } = context(
    {
      'stripe.listWebhooks': {
        data: [
          {
            id: 'fixture_path',
            url: `https://app.dayopt.app/private/${fixtureSecret}?query=${fixtureQuery}`,
          },
        ],
        has_more: false,
      },
    },
    'integration',
  );
  const output = await readService('stripe', ctx);
  assert.ok(!JSON.stringify(output).includes(fixtureSecret));
  assert.ok(!JSON.stringify(output).includes(fixtureQuery));
});

test('Upstash unknown response shape is blocked rather than a successful reachability observation', async () => {
  const { ctx } = context({ 'upstash.ping': { unexpected: true } });
  const output = await readService('upstash', ctx);
  assert.equal(output.find((row) => row.key === 'upstash.ping')?.status, 'blocked');
  assert.equal(output.find((row) => row.key === 'upstash.ping')?.value, null);
});

test.each(['preview', 'integration'] as const)(
  'Upstash %s scope reports the shared credential target and leaves isolation manual',
  async (environment) => {
    const { ctx } = context({}, environment);
    const output = await readService('upstash', ctx);
    const ping = output.find((entry) => entry.key === 'upstash.ping');
    assert.equal(ping?.environment, 'shared');
    assert.deepEqual(
      ping?.value && (ping.value as Record<string, unknown>).credential_target,
      'agent_master',
    );
    const isolation = output.find((entry) => entry.key === 'upstash.environment_isolation');
    assert.equal(isolation?.environment, environment);
    assert.equal(isolation?.status, 'manual');
  },
);

test('R2 missing bucket array is blocked, not a successful empty inventory', async () => {
  const { ctx } = context({ 'cloudflare.listR2Buckets': { success: true, result: {} } });
  const output = await readService('cloudflare', ctx);
  assert.equal(output.find((entry) => entry.key === 'cloudflare.r2_buckets')?.status, 'blocked');
  assert.equal(output.find((entry) => entry.key === 'cloudflare.r2_buckets')?.value, null);
});

test('R2 missing lock array is blocked on each bucket', async () => {
  const { ctx } = context({ 'cloudflare.getR2Locks': { success: true, result: {} } });
  const output = await readService('cloudflare', ctx);
  for (const bucket of ['avatars', 'attachments']) {
    assert.equal(
      output.find((entry) => entry.key === `cloudflare.r2_locks.${bucket}`)?.status,
      'blocked',
    );
  }
});

test('R2 explicit empty arrays remain valid metadata', async () => {
  const { ctx } = context({
    'cloudflare.listR2Buckets': { success: true, result: { buckets: [] } },
    'cloudflare.getR2Locks': { success: true, result: { rules: [] } },
  });
  const output = await readService('cloudflare', ctx);
  for (const key of [
    'cloudflare.r2_buckets',
    'cloudflare.r2_locks.avatars',
    'cloudflare.r2_locks.attachments',
  ]) {
    const observation = output.find((entry) => entry.key === key);
    assert.equal(observation?.status, undefined);
    assert.deepEqual(observation?.value, []);
  }
});

test('Provider failure payload is not treated as an empty successful list', async () => {
  const { ctx } = context({
    'cloudflare.listZones': { success: false, errors: [{ message: fixtureSecret }] },
  });
  const output = await readService('cloudflare', ctx);
  assert.equal(output.find((row) => row.key === 'cloudflare.zone')?.status, 'blocked');
  assert.ok(!JSON.stringify(output).includes(fixtureSecret));
});

test('Unsupported service cannot trigger transport', async () => {
  const { ctx, calls } = context();
  const output = await readService('unsupported', ctx);
  assert.equal(output[0]?.status, 'not_applicable');
  assert.equal(calls.length, 0);
});
