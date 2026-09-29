import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';
import {
  createFixtureLifecycle,
  createSupabaseFixtureLifecycle,
} from './preview-fixture-lifecycle.mjs';

const binding = {
  key: 'abcdefghijklmnopqrst:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  intentDigest: 'a'.repeat(64),
  operation: 'provision',
};
const invalid = /^Preview fixture lifecycle failed$/;
function setup(
  statuses: unknown[] = [{ status: 'acquired' }, { status: 'owned' }, { status: 'finished' }],
) {
  let now = 0;
  const rpc = vi.fn(
    async (_name: string, _args: Record<string, unknown>, _options: { signal: AbortSignal }) => {
      const result = statuses.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const wait = vi.fn(async (ms: number) => {
    now += ms;
  });
  const elapsed = () => now;
  return {
    rpc,
    wait,
    elapsed,
    run: createFixtureLifecycle({ rpc, wait, elapsed }),
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe('durable fixture lifecycle RPC adapter with mocked provider and clock', () => {
  it('claims once, guards before mutation, finishes with success and preserves callback result', async () => {
    const s = setup();
    expect(
      await s.run(binding, async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
        await beforeMutation();
        return 'value';
      }),
    ).toBe('value');
    expect(s.rpc.mock.calls.map((c) => [c[1].p_action, c[1].p_success])).toEqual([
      ['claim', null],
      ['guard', null],
      ['finish', true],
    ]);
    expect(new Set(s.rpc.mock.calls.map((c) => c[1].p_owner_id)).size).toBe(1);
    for (const [name, args, options] of s.rpc.mock.calls) {
      expect(name).toBe('preview_fixture_lifecycle_v1');
      expect(args.p_database_ref).toBe('abcdefghijklmnopqrst');
      expect(args.p_owner_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
    }
  });
  it('waits on busy, then acquires using the same owner', async () => {
    const s = setup([
      { status: 'busy' },
      { status: 'busy' },
      { status: 'acquired' },
      { status: 'finished' },
    ]);
    await s.run(binding, async () => undefined);
    expect(s.wait.mock.calls).toEqual([[500], [500]]);
    expect(new Set(s.rpc.mock.calls.map((c) => c[1].p_owner_id)).size).toBe(1);
  });
  it('bounds busy retries even if an injected clock never advances', async () => {
    const rpc = vi.fn(async () => ({ status: 'busy' }));
    const wait = vi.fn(async () => undefined);
    const execute = vi.fn();
    await expect(
      createFixtureLifecycle({ rpc, wait, elapsed: () => 0 })(binding, execute),
    ).rejects.toThrow(invalid);
    expect(rpc).toHaveBeenCalledTimes(30);
    expect(execute).not.toHaveBeenCalled();
  });
  it('stops at the 15 second boundary without another claim', async () => {
    const s = setup([{ status: 'busy' }]);
    s.wait.mockImplementationOnce(async () => {
      s.setNow(15_000);
    });
    await expect(s.run(binding, vi.fn())).rejects.toThrow(invalid);
    expect(s.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['closed', 'unknown', 'denied', 'owned', 'finished'])(
    'never enters callback after claim %s',
    async (status) => {
      const s = setup([{ status }]);
      const execute = vi.fn();
      await expect(s.run(binding, execute)).rejects.toThrow(invalid);
      expect(execute).not.toHaveBeenCalled();
      expect(s.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    null,
    [],
    {},
    { status: 'new' },
    { status: 'acquired', secret: 'PRIVATE' },
    new Error('PRIVATE_PROVIDER'),
  ])('rejects malformed or failed claim %#', async (status) => {
    const s = setup([status]);
    await expect(s.run(binding, vi.fn())).rejects.toThrow(invalid);
  });
  it('latches guard loss even when callback catches it and retries', async () => {
    const s = setup([{ status: 'acquired' }, { status: 'unknown' }, { status: 'finished' }]);
    await expect(
      s.run(binding, async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
        await expect(beforeMutation()).rejects.toThrow(invalid);
        await expect(beforeMutation()).rejects.toThrow(invalid);
        return 'ignored';
      }),
    ).rejects.toThrow(invalid);
    expect(s.rpc.mock.calls.map((c) => [c[1].p_action, c[1].p_success])).toEqual([
      ['claim', null],
      ['guard', null],
      ['finish', false],
    ]);
  });
  it('reports failed execution and suppresses provider error contents', async () => {
    const s = setup([{ status: 'acquired' }, { status: 'finished' }]);
    await expect(
      s.run(binding, async () => {
        throw new Error('PRIVATE_PASSWORD');
      }),
    ).rejects.toThrow(invalid);
    expect(s.rpc.mock.calls[1][1].p_success).toBe(false);
  });
  it.each(['unknown', 'denied', 'busy', 'acquired', 'owned', 'closed'])(
    'rejects finish %s even after successful callback',
    async (status) => {
      const s = setup([{ status: 'acquired' }, { status }]);
      await expect(s.run(binding, async () => 'value')).rejects.toThrow(invalid);
    },
  );
  it('fails when the callback returns while a guard RPC is still pending', async () => {
    let resolveGuard!: (value: { status: string }) => void;
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.p_action === 'guard')
        return new Promise<{ status: string }>((resolve) => {
          resolveGuard = resolve;
        });
      return { status: args.p_action === 'claim' ? 'acquired' : 'finished' };
    });
    let pending: Promise<void> | undefined;
    await expect(
      createFixtureLifecycle({ rpc })(
        binding,
        async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
          pending = beforeMutation();
        },
      ),
    ).rejects.toThrow(invalid);
    expect(rpc.mock.calls.at(-1)?.[1].p_success).toBe(false);
    resolveGuard({ status: 'owned' });
    await expect(pending).rejects.toThrow(invalid);
  });
  it('uses independent owner IDs for concurrent operations', async () => {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      status: args.p_action === 'claim' ? 'acquired' : 'finished',
    }));
    const run = createFixtureLifecycle({ rpc });
    await Promise.all([
      run(binding, async () => 1),
      run({ ...binding, operation: 'cleanup' }, async () => 2),
    ]);
    const claims = rpc.mock.calls.filter((c) => c[1].p_action === 'claim');
    expect(new Set(claims.map((c) => c[1].p_owner_id)).size).toBe(2);
  });
  it.each([SUPABASE_PRODUCTION_PROJECT_REF, 'tilwaprottpyhlfoggbb', 'UPPERCASEUPPERCASEUPP'])(
    'rejects unsafe database ref %s without RPC',
    async (ref) => {
      const s = setup();
      await expect(
        s.run({ ...binding, key: `${ref}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }, vi.fn()),
      ).rejects.toThrow(invalid);
      expect(s.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...binding, extra: 'PRIVATE' },
    { ...binding, intentDigest: 'bad' },
    { ...binding, operation: 'reset' },
    { ...binding, key: 'abcdefghijklmnopqrst:00000000-0000-0000-0000-000000000001' },
  ])('rejects malformed binding %#', async (value) => {
    const s = setup();
    await expect(s.run(value, vi.fn())).rejects.toThrow(invalid);
    expect(s.rpc).not.toHaveBeenCalled();
  });
});

const { createClient } = createRequire(new URL('../../apps/product/package.json', import.meta.url))(
  '@supabase/supabase-js',
);
describe('installed Supabase SDK lifecycle bridge with mocked transport', () => {
  function sdk(responses: { status: number; body: unknown }[]) {
    const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
      const response = responses.shift();
      if (!response) throw new Error('PRIVATE_PROVIDER');
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createClient(
      'https://abcdefghijklmnopqrst.supabase.co',
      'synthetic-sdk-key-not-real',
      { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } },
    );
    return { requests, transport, run: createSupabaseFixtureLifecycle({ client }) };
  }
  it('sends claim, guard and finish through the exact RPC with an abort signal', async () => {
    const s = sdk([
      { status: 200, body: { status: 'acquired' } },
      { status: 200, body: { status: 'owned' } },
      { status: 200, body: { status: 'finished' } },
    ]);
    expect(
      await s.run(binding, async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
        await beforeMutation();
        return 'ready';
      }),
    ).toBe('ready');
    expect(s.requests.map((r) => r.body.p_action)).toEqual(['claim', 'guard', 'finish']);
    expect(s.requests.map((r) => r.body.p_success)).toEqual([null, null, true]);
    for (const r of s.requests) {
      expect(r.url).toBe(
        'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/preview_fixture_lifecycle_v1',
      );
      expect(r.init.method).toBe('POST');
      expect(r.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('rejects provider HTTP errors before entering the callback', async () => {
    const s = sdk([{ status: 403, body: { message: 'PRIVATE_PROVIDER', code: '42501' } }]);
    const execute = vi.fn();
    await expect(s.run(binding, execute)).rejects.toThrow(invalid);
    expect(execute).not.toHaveBeenCalled();
  });
  it('marks guard HTTP failure as failed finish without returning callback data', async () => {
    const s = sdk([
      { status: 200, body: { status: 'acquired' } },
      { status: 500, body: { message: 'PRIVATE_PROVIDER' } },
      { status: 200, body: { status: 'unknown' } },
    ]);
    await expect(
      s.run(binding, async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
        await beforeMutation();
        return 'PRIVATE_RESULT';
      }),
    ).rejects.toThrow(invalid);
    expect(s.requests.map((r) => [r.body.p_action, r.body.p_success])).toEqual([
      ['claim', null],
      ['guard', null],
      ['finish', false],
    ]);
  });
  it('rejects null successful responses and transport exceptions', async () => {
    for (const responses of [[{ status: 200, body: null }], []]) {
      const s = sdk(responses);
      const execute = vi.fn();
      await expect(s.run(binding, execute)).rejects.toThrow(invalid);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('never returns fixture data after an unconfirmed finish response', async () => {
    const s = sdk([{ status: 200, body: { status: 'acquired' } }]);
    await expect(s.run(binding, async () => 'PRIVATE_RESULT')).rejects.toThrow(invalid);
  });
  it('forwards an aborted signal to installed SDK fetch', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(aborted.signal);
      throw new Error('PRIVATE_PROVIDER');
    });
    const client = createClient(
      'https://abcdefghijklmnopqrst.supabase.co',
      'synthetic-sdk-key-not-real',
      { global: { fetch: transport } },
    );
    const result = await client
      .rpc('preview_fixture_lifecycle_v1', { p_action: 'guard' })
      .abortSignal(aborted.signal);
    expect(result.error).toBeTruthy();
    expect(transport).toHaveBeenCalled();
  });
});
