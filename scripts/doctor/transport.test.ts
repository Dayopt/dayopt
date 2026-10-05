import { describe, expect, it, vi } from 'vitest';
import { createTransport, METADATA_SQL } from './transport.ts';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const ENV = {
  GH_TOKEN: 'fake-github',
  VERCEL_TOKEN: 'fake-vercel',
  VERCEL_TEAM_ID: 'fake-team',
  SUPABASE_ACCESS_TOKEN: 'fake-supabase',
  STRIPE_TEST_SECRET_KEY: 'fake-stripe',
  POSTHOG_READONLY: 'fake-posthog',
  UPTIME_KEY: 'fake-uptime',
};
describe('doctor read transport', () => {
  it('reads only the fixed public registration endpoint without credentials or other domains', async () => {
    const mock = vi.fn().mockResolvedValue(json({ ldhName: 'dayopt.app' }));
    const request = createTransport(ENV, mock);
    await expect(request('public.domain_registration')).resolves.toMatchObject({
      ldhName: 'dayopt.app',
    });
    expect(String(mock.mock.calls[0][0])).toBe(
      'https://pubapi.registry.google/rdap/domain/dayopt.app',
    );
    expect(mock.mock.calls[0][1].method).toBe('GET');
    expect(mock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    await expect(
      request('public.domain_registration', { domain: 'other.app' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('reads R2 bucket locks from the singular lock endpoint in the verified account', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          success: true,
          result: [{ name: 'dayopt.app', account: { id: 'account_dayopt' } }],
        }),
      )
      .mockResolvedValueOnce(json({ success: true, result: { rules: [] } }));
    const request = createTransport({ ...ENV, CF_TOKEN: 'fake-cloudflare' }, mock);
    await request('cloudflare.listZones');
    await request('cloudflare.getR2Locks', { account_id: 'account_dayopt', bucket: 'avatars' });
    expect(new URL(mock.mock.calls[1][0]).pathname).toBe(
      '/client/v4/accounts/account_dayopt/r2/buckets/avatars/lock',
    );
    expect(mock.mock.calls[1][1].method).toBe('GET');
  });
  it.each([401, 403, 404])('classifies HTTP %s without exposing response body', async (status) => {
    const mock = vi.fn().mockResolvedValue(json({ secret: 'FAKE_RESPONSE_SECRET' }, status));
    await expect(createTransport(ENV, mock)('github.repository')).rejects.toMatchObject({ status });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('classifies a Resend sending-only key as scope-limited even when the provider uses 401', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        json({ name: 'restricted_api_key', message: 'FAKE_SECRET_DO_NOT_PRINT' }, 401),
      );
    await expect(
      createTransport({ ...ENV, RESEND_API_KEY: 'fake-resend' }, mock)('resend.listDomains'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 401 });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects mutation and arbitrary endpoints without network calls', async () => {
    const mock = vi.fn();
    const request = createTransport(ENV, mock);
    for (const operation of [
      'github.create',
      'vercel.deploy',
      'stripe.charge',
      'resend.send',
      'supabase.migrate',
    ]) {
      await expect(
        request(operation, {
          project: 'product',
          project_ref: 'yvglwblxrnrenfifsnje',
          mode: 'test',
          url: 'https://attacker.test',
        }),
      ).rejects.toThrow();
    }
    expect(mock).not.toHaveBeenCalled();
  });
  it('posts only the fixed read-only SQL, ignoring injected SQL params', async () => {
    const mock = vi.fn().mockResolvedValue(json([]));
    await createTransport(ENV, mock)('supabase.database_metadata', {
      project_ref: 'yvglwblxrnrenfifsnje',
      query: 'DELETE FROM auth.users',
    });
    const init = mock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ query: METADATA_SQL, read_only: true });
    expect(init.redirect).toBe('error');
    expect(METADATA_SQL).not.toMatch(
      /auth\.users|storage\.objects\s+(?:WHERE|ORDER)|vault\.|\bcommand\b/i,
    );
  });
  it('aggregates complete Github pagination and fails if a later page fails', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        json([{ id: 1 }], 200, {
          link: '<https://api.github.com/repos/Dayopt/dayopt/hooks?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(json({ secret: 'do-not-print' }, 403));
    await expect(createTransport(ENV, mock)('github.repository_hooks')).rejects.toMatchObject({
      status: 403,
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('stops Sentry pagination when its next link says results=false', async () => {
    const mock = vi.fn().mockResolvedValue(
      json([{ slug: 'dayopt' }], 200, {
        link: '<https://sentry.io/api/0/organizations/dayopt/projects/?cursor=end>; rel="next"; results="false"; cursor="end"',
      }),
    );
    await expect(
      createTransport({ ...ENV, SENTRY_AUTH_TOKEN: 'fake-sentry' }, mock)('sentry.listProjects'),
    ).resolves.toEqual([{ slug: 'dayopt' }]);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('allows only scoped Sentry metadata GETs and never uses a write method', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(json({ slug: 'dayopt' }))
      .mockResolvedValueOnce(json({ id: 'org_dayopt' }))
      .mockResolvedValueOnce(json([{ name: 'production', visibility: 'visible' }]))
      .mockResolvedValueOnce(json([]));
    const request = createTransport({ ...ENV, SENTRY_AUTH_TOKEN: 'fake-sentry' }, mock);
    await request('sentry.getProject', { project: 'dayopt' });
    await request('sentry.getOrganization');
    await request('sentry.listProjectEnvironments', { project: 'dayopt' });
    await request('sentry.listProjectHooks', { project: 'dayopt' });
    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock.mock.calls.map(([input, init]) => [new URL(input).pathname, init.method])).toEqual([
      ['/api/0/projects/dayopt/dayopt/', 'GET'],
      ['/api/0/organizations/dayopt/', 'GET'],
      ['/api/0/projects/dayopt/dayopt/environments/', 'GET'],
      ['/api/0/projects/dayopt/dayopt/hooks/', 'GET'],
    ]);
    expect(new URL(mock.mock.calls[2][0]).searchParams.get('visibility')).toBe('all');
    await expect(request('sentry.getProject', { project: 'unrelated' })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    await expect(request('sentry.updateProject', { project: 'dayopt' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('limits Sentry release metadata to the newest 20 and does not fetch later pages', async () => {
    const mock = vi.fn().mockResolvedValue(
      json([{ version: 'release-1' }], 200, {
        link: '<https://sentry.io/api/0/projects/dayopt/dayopt/releases/?cursor=next>; rel="next"; results="true"',
      }),
    );
    await expect(
      createTransport({ ...ENV, SENTRY_AUTH_TOKEN: 'fake-sentry' }, mock)('sentry.listReleases', {
        project: 'dayopt',
        limit: 20,
      }),
    ).resolves.toEqual([{ version: 'release-1' }]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(new URL(mock.mock.calls[0][0]).searchParams.get('per_page')).toBe('20');
    expect(mock.mock.calls[0][1].method).toBe('GET');
  });
  it('refuses pagination links that escape the scoped endpoint', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(json([], 200, { link: '<https://attacker.test/stolen>; rel="next"' }));
    await expect(createTransport(ENV, mock)('github.repository_hooks')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not retry access failures but retries 429 and transient 5xx at most twice', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ full_name: 'Dayopt/dayopt' }));
    await expect(createTransport(ENV, mock)('github.repository')).resolves.toMatchObject({
      full_name: 'Dayopt/dayopt',
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('pins Stripe account before reading any prices or webhooks', async () => {
    const mock = vi.fn().mockResolvedValue(json({ id: 'acct_unrelated' }));
    await expect(
      createTransport(ENV, mock)('stripe.listPrices', { mode: 'test' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0][0])).toBe('https://api.stripe.com/v1/account');
  });
  it('projects PostHog aggregate tuples and never accepts arbitrary queries', async () => {
    const mock = vi.fn().mockResolvedValue(json({ results: [['preview', 12]] }));
    const result = await createTransport(ENV, mock)('posthog.aggregate', {
      query: 'SELECT person_id FROM persons',
    });
    expect(result).toEqual([{ environment: 'preview', count: 12 }]);
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.query.query).toContain('properties.environment');
    expect(body.query.query).not.toMatch(/person_id|distinct_id|SELECT \*/i);
  });
  it('uses the explicit UptimeRobot read operation only', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(json({ stat: 'ok', monitors: [], pagination: { total: 0 } }));
    await createTransport(ENV, mock)('uptimerobot.getMonitors');
    expect(String(mock.mock.calls[0][0])).toBe('https://api.uptimerobot.com/v2/getMonitors');
    expect(mock.mock.calls[0][1].method).toBe('POST');
  });
  it('never decodes sensitive Vercel env or reads secret values', async () => {
    const mock = vi.fn().mockResolvedValue(
      json({
        envs: [
          {
            id: 'e1',
            key: 'CALENDAR_TOKEN_ENCRYPTION_KEY',
            type: 'sensitive',
            target: ['preview'],
          },
          { id: 'e2', key: 'GOOGLE_CALENDAR_CLIENT_ID', type: 'sensitive', target: ['production'] },
        ],
      }),
    );
    const result = await createTransport(ENV, mock)('vercel.binding', {
      project: 'product',
      environment: 'all',
    });
    expect(result).toEqual([
      { key: 'CALENDAR_TOKEN_ENCRYPTION_KEY', target: ['preview'], gitBranch: null, present: true },
      {
        key: 'GOOGLE_CALENDAR_CLIENT_ID',
        target: ['production'],
        gitBranch: null,
        value: { unavailable: 'sensitive' },
      },
    ]);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
