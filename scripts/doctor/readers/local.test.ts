import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderContext } from '../types';
import { readLocal } from './local';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  constructor: vi.fn(),
  ns: vi.fn(),
  cname: vi.fn(),
  mx: vi.fn(),
  txt: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ access: mocks.access }));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    constructor(options: unknown) {
      mocks.constructor(options);
    }
    resolveNs = mocks.ns;
    resolveCname = mocks.cname;
    resolveMx = mocks.mx;
    resolveTxt = mocks.txt;
  },
}));

const context = (environment: ReaderContext['environment'] = 'all'): ReaderContext => ({
  environment,
  root: '/repository',
  request: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.ns.mockResolvedValue(['keira.ns.cloudflare.com', 'colin.ns.cloudflare.com']);
  mocks.cname.mockResolvedValue(['cname.vercel-dns-017.com']);
  mocks.mx.mockResolvedValue([{ priority: 10, exchange: 'mx.example.test' }]);
  mocks.txt.mockImplementation(async (host: string) =>
    host.startsWith('_dmarc')
      ? [['v=DMARC1; p=none; rua=mailto:report@example.test']]
      : host.startsWith('resend._domainkey')
        ? [['v=DKIM1; k=rsa; p=PUBLICKEY']]
        : [['v=spf1 include:amazonses.com -all'], ['google-site-verification=not-output']],
  );
});

describe('local doctor reader', () => {
  it('tracks 1Password access and recovery without authenticating or reading items', async () => {
    const ctx = context();
    const result = await readLocal('onepassword', ctx);
    expect(result).toMatchObject([
      { key: 'onepassword.source_contract', environment: 'shared' },
      { key: 'onepassword.access_and_recovery', status: 'manual', value: null },
    ]);
    expect(ctx.request).not.toHaveBeenCalled();
    expect(mocks.ns).not.toHaveBeenCalled();
  });
  it('keeps notification authority separate from Sentry metadata and token names', async () => {
    const ctx = context();
    expect(await readLocal('sentry', ctx)).toMatchObject([
      { key: 'sentry.alert_authority', status: 'manual', value: null },
    ]);
    expect(ctx.request).not.toHaveBeenCalled();
  });
  it('retains installed GitHub Apps as a manual inventory check without treating hooks as Apps', async () => {
    const ctx = context();
    expect(await readLocal('github', ctx)).toMatchObject([
      { key: 'github.installed_apps', status: 'manual', value: null },
    ]);
    expect(ctx.request).not.toHaveBeenCalled();
  });
  it.each(['google', 'mcp_oauth', 'telemetry', 'pwned_passwords', 'support_smtp', 'optional'])(
    'keeps %s source presence separate from unverified live settings',
    async (service) => {
      const ctx = context();
      const result = await readLocal(service, ctx);
      expect(result[0].key).toBe(`${service}.source_contract`);
      expect(result[0].value).toEqual({
        files: expect.arrayContaining([expect.objectContaining({ present: true })]),
      });
      expect(result[0].status).toBeUndefined();
      expect(result[1].key).not.toBe(result[0].key);
      expect(result[1]).toMatchObject({ status: 'manual', value: null });
      expect(result[1].next_step).toBeTruthy();
      if (service === 'mcp_oauth') expect(ctx.request).toHaveBeenCalledTimes(2);
      else expect(ctx.request).not.toHaveBeenCalled();
      expect(mocks.ns).not.toHaveBeenCalled();
    },
  );

  it('reports missing contract paths without filesystem errors or secret material', async () => {
    mocks.access.mockRejectedValue(new Error('secret filesystem error'));
    const result = await readLocal('google', context());
    expect(result[0]).toMatchObject({ status: 'blocked', reason: 'source_contract_missing' });
    expect(JSON.stringify(result)).not.toContain('secret filesystem error');
  });

  it('queries only fixed public DNS names, with a bounded resolver', async () => {
    const ctx = context();
    const result = await readLocal('cloudflare', ctx);
    expect(mocks.constructor).toHaveBeenCalledWith({ timeout: 10_000, tries: 1 });
    expect(mocks.ns).toHaveBeenCalledWith('dayopt.app');
    expect(mocks.cname.mock.calls).toEqual([['app.dayopt.app'], ['mcp.dayopt.app']]);
    expect(result).toHaveLength(14);
    for (const key of ['email_routing', 'zone_operations', 'restore_readiness'])
      expect(result.find((row) => row.key === `cloudflare.${key}`)).toMatchObject({
        status: 'manual',
        value: null,
      });
    expect(result.find((row) => row.key.endsWith('.dkim'))?.value).toEqual([
      { record_present: true, public_key_present: true, key_type: 'rsa' },
    ]);
    expect(result.find((row) => row.key.endsWith('.dmarc'))?.value).toEqual([{ policy: 'none' }]);
    expect(JSON.stringify(result)).not.toContain('PUBLICKEY');
    expect(JSON.stringify(result)).not.toContain('google-site-verification');
    expect(ctx.request).toHaveBeenCalledExactlyOnceWith('public.domain_registration');
  });

  it('projects registrar and expiry metadata without registrant contacts or raw RDAP entities', async () => {
    const ctx = context();
    ctx.request = vi.fn().mockResolvedValue({
      ldhName: 'dayopt.app',
      status: ['client transfer prohibited'],
      secureDNS: { delegationSigned: false },
      nameservers: [{ ldhName: 'colin.ns.cloudflare.com' }],
      events: [{ eventAction: 'expiration', eventDate: '2027-01-05T01:10:42Z' }],
      entities: [
        {
          roles: ['registrar'],
          handle: '625',
          vcardArray: [
            'vcard',
            [
              ['fn', {}, 'text', 'Name.com, Inc.'],
              ['email', {}, 'text', 'FAKE_CONTACT'],
            ],
          ],
        },
        { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'FAKE_OWNER']]] },
      ],
    });
    const result = await readLocal('cloudflare', ctx);
    expect(result.find((row) => row.key === 'cloudflare.registrar_metadata')).toMatchObject({
      value: {
        domain: 'dayopt.app',
        registrar: [{ id: '625', name: 'Name.com, Inc.' }],
        delegation_signed: false,
      },
    });
    expect(result.find((row) => row.key === 'cloudflare.registrar_operations')).toMatchObject({
      status: 'manual',
      value: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/FAKE_CONTACT|FAKE_OWNER/);
    ctx.request = vi.fn().mockResolvedValue({ ldhName: 'other.app' });
    expect(
      (await readLocal('cloudflare', ctx)).find(
        (row) => row.key === 'cloudflare.registrar_metadata',
      ),
    ).toMatchObject({ status: 'blocked', value: null });
  });

  it('isolates individual DNS errors and never treats a lookup failure as an empty record', async () => {
    mocks.ns.mockRejectedValue(new Error('private provider diagnostic'));
    const result = await readLocal('cloudflare', context());
    expect(result.find((row) => row.key.endsWith('.ns'))).toMatchObject({
      status: 'blocked',
      value: null,
    });
    expect(result.find((row) => row.key.endsWith('.dkim'))?.status).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private provider diagnostic');
  });

  it('projects actual public health response without unrelated payload fields', async () => {
    const ctx = context('integration');
    ctx.request = vi.fn().mockResolvedValue({
      version: '1.2.3',
      commitSha: 'abcdef1',
      preview: {
        sha: 'a'.repeat(40),
        supabaseProjectRef: 'tilwaprottpyhlfoggbb',
        token: 'do-not-emit',
      },
      secret: 'do-not-emit',
    });
    const result = await readLocal('vercel', ctx);
    expect(ctx.request).toHaveBeenCalledExactlyOnceWith('public.health', { target: 'integration' });
    expect(result).toEqual([
      {
        key: 'vercel.integration.public_health',
        environment: 'integration',
        source: 'public.health',
        value: {
          sha: 'a'.repeat(40),
          version: '1.2.3',
          supabase_project_ref: 'tilwaprottpyhlfoggbb',
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-emit');
  });

  it('does not invent a Production database reference from the health endpoint', async () => {
    const ctx = context('production');
    ctx.request = vi.fn().mockResolvedValue({ version: '1.2.3', commitSha: 'abcdef1' });
    const result = await readLocal('vercel', ctx);
    expect(result[0].value).toMatchObject({ supabase_project_ref: null });
  });

  it('keeps protected or malformed health responses blocked without error content', async () => {
    const ctx = context();
    ctx.request = vi.fn().mockRejectedValue(new Error('https://private.test/?token=do-not-emit'));
    const result = await readLocal('vercel', ctx);
    expect(result).toHaveLength(3);
    expect(result.find((row) => row.environment === 'preview')?.status).toBe('manual');
    expect(
      result
        .filter((row) => row.environment !== 'preview')
        .every((row) => row.status === 'blocked' && row.value === null),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('do-not-emit');
    ctx.request = vi.fn().mockResolvedValue({ version: 'secret-value', commitSha: 'bad' });
    expect((await readLocal('vercel', ctx))[0].status).toBe('blocked');
  });

  it('does not choose an arbitrary PR preview target or unknown service', async () => {
    const ctx = context('preview');
    expect((await readLocal('vercel', ctx))[0].status).toBe('manual');
    expect(await readLocal('unknown', ctx)).toEqual([]);
    expect(ctx.request).not.toHaveBeenCalled();
  });
});
