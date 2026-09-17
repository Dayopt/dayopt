import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

import { SUPABASE_TRACE_PROPAGATION } from './trace-propagation';

/**
 * supabase-js が tracing runtime を探す globalThis key。
 * `@supabase/supabase-js/tracing` の副作用 import がここへ extractor を登録し、
 * fetch 時に読まれる。未登録なら header は付かない（silent no-op の検出点）。
 */
const EXTRACTOR_KEY = Symbol.for('@supabase/supabase-js.traceContextExtractor');

const SUPABASE_URL = 'https://trace-propagation-test.supabase.co';
const ANON_KEY = 'test-anon-key';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

type MutableGlobal = typeof globalThis & Record<symbol, unknown>;

/** stub fetch に届いた Request headers を集める。 */
function createFetchRecorder() {
  const headers: Headers[] = [];
  const fetchStub = vi.fn(async (_input: unknown, init?: { headers?: HeadersInit }) => {
    headers.push(new Headers(init?.headers));
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { headers, fetchStub };
}

describe('Supabase tracePropagation', () => {
  const originalExtractor = (globalThis as MutableGlobal)[EXTRACTOR_KEY];

  beforeEach(() => {
    // 実 runtime の代わりに固定の trace context を返す extractor を差す。
    // OpenTelemetry SDK を持ち込まずに「extractor があれば header が付く」を固定できる。
    (globalThis as MutableGlobal)[EXTRACTOR_KEY] = () => ({ traceparent: TRACEPARENT });
  });

  afterEach(() => {
    if (originalExtractor === undefined) {
      delete (globalThis as MutableGlobal)[EXTRACTOR_KEY];
    } else {
      (globalThis as MutableGlobal)[EXTRACTOR_KEY] = originalExtractor;
    }
    vi.restoreAllMocks();
  });

  it('opt-in した client は Supabase 宛 request に traceparent を付ける', async () => {
    const { headers, fetchStub } = createFetchRecorder();
    const supabase = createSupabaseJsClient(SUPABASE_URL, ANON_KEY, {
      tracePropagation: SUPABASE_TRACE_PROPAGATION,
      global: { fetch: fetchStub as unknown as typeof fetch },
    });

    await supabase.from('plans').select('id');

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(headers[0]?.get('traceparent')).toBe(TRACEPARENT);
  });

  it('opt-in していない client には traceparent が付かない', async () => {
    const { headers, fetchStub } = createFetchRecorder();
    const supabase = createSupabaseJsClient(SUPABASE_URL, ANON_KEY, {
      global: { fetch: fetchStub as unknown as typeof fetch },
    });

    await supabase.from('plans').select('id');

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(headers[0]?.get('traceparent')).toBeNull();
  });

  it('extractor が未登録なら opt-in していても traceparent は付かない（tracing runtime 未読込の検出）', async () => {
    delete (globalThis as MutableGlobal)[EXTRACTOR_KEY];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { headers, fetchStub } = createFetchRecorder();
    const supabase = createSupabaseJsClient(SUPABASE_URL, ANON_KEY, {
      tracePropagation: SUPABASE_TRACE_PROPAGATION,
      global: { fetch: fetchStub as unknown as typeof fetch },
    });

    await supabase.from('plans').select('id');

    expect(headers[0]?.get('traceparent')).toBeNull();
    warn.mockRestore();
  });
});
