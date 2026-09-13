import { describe, expect, it } from 'vitest';

import {
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentrySpan,
  sanitizeSentryTransaction,
  sanitizeTechnicalContext,
} from './sanitize';

describe('sanitizeSentryEvent', () => {
  it('preserves Sentry protocol identifiers and release metadata verbatim', () => {
    const eventId = 'a'.repeat(32);
    const traceId = 'b'.repeat(32);
    const spanId = 'c'.repeat(16);
    const parentSpanId = 'd'.repeat(16);
    const release = 'e'.repeat(40);
    const environment = 'production-environment-with-a-long-name';
    const dist = 'f'.repeat(40);

    const result = sanitizeSentryEvent({
      event_id: eventId,
      release,
      environment,
      dist,
      contexts: {
        trace: {
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          op: 'http.server',
          privateToken: 'do-not-send',
        },
      },
    });

    expect(result).toMatchObject({ event_id: eventId, release, environment, dist });
    expect(result.contexts).toEqual({
      trace: {
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        op: 'http.server',
      },
    });
  });

  it('scrubs top-level message and limits request and user data', () => {
    const userId = '12345678-1234-4234-9234-123456789abc';
    const result = sanitizeSentryEvent({
      message: `failed for alice@example.com token=${'x'.repeat(40)}`,
      request: {
        url: 'https://app.dayopt.com/private?email=alice@example.com#secret',
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          Accept: 'application/json',
          'User-Agent': 'private fingerprint',
        },
        query_string: 'search=private',
        cookies: 'session=secret',
        data: { contactMessage: 'private feedback' },
      },
      user: { id: userId, email: 'alice@example.com', ip_address: '127.0.0.1' },
    });

    expect(result.message).toBe('[REDACTED]');
    expect(result.request).toEqual({
      url: 'https://app.dayopt.com/private',
      method: 'POST',
    });
    expect(result.user).toEqual({ id: userId });
  });

  it('drops every request header, including previously allowlisted technical names', () => {
    const privateValue = 'private-patient-name';
    const result = sanitizeSentryEvent({
      request: {
        url: 'https://app.dayopt.app/contact',
        method: 'POST',
        headers: {
          Accept: privateValue,
          'Content-Type': privateValue,
          Host: privateValue,
        },
      },
    });

    expect(result.request).toEqual({
      url: 'https://app.dayopt.app/contact',
      method: 'POST',
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it('drops user context unless the id is an internal Supabase UUID', () => {
    expect(sanitizeSentryEvent({ user: { id: 'alice@example.com' } })).toEqual({});
    expect(sanitizeSentryEvent({ user: { id: 'short-private-id' } })).toEqual({});
  });

  it('keeps only a normalized CSP message from the captureMessage path', () => {
    expect(sanitizeSentryEvent({ message: 'CSP Violation: script-src-elem' }).message).toBe(
      'CSP Violation: script-src-elem',
    );
    expect(
      sanitizeSentryEvent({ message: 'CSP Violation: script-src alice@example.com' }).message,
    ).toBe('[REDACTED]');
  });

  it('redacts raw, encoded, and double-encoded email addresses in URL path segments', () => {
    const result = sanitizeSentryEvent({
      request: {
        url: 'https://app.dayopt.app/users/alice%2540example.com?token=secret',
      },
      breadcrumbs: [
        { data: { url: '/users/alice@example.com' } },
        { data: { url: '/users/alice%40example.com' } },
      ],
    });

    expect(result.request).toEqual({
      url: 'https://app.dayopt.app/users/[REDACTED_EMAIL]',
    });
    expect(result.breadcrumbs).toEqual([
      { data: { url: '/users/[REDACTED_EMAIL]' } },
      { data: { url: '/users/[REDACTED_EMAIL]' } },
    ]);
  });

  it('redacts email addresses with a linear scanner and handles long plus-only input', () => {
    const longUntrustedValue = '+'.repeat(100_000);
    const result = sanitizeSentryEvent({
      contexts: {
        react: {
          componentStack: `Widget alice+alerts@example.com ${longUntrustedValue}`,
        },
      },
    });

    expect(result.contexts).toEqual({
      react: {
        componentStack: `Widget [REDACTED_EMAIL] ${longUntrustedValue}`,
      },
    });
  });

  it.each([
    ['alice@example.com-test', '[REDACTED_EMAIL]-test'],
    ['alice@example.com_suffix', '[REDACTED_EMAIL]_suffix'],
    ['alice@example.com123', '[REDACTED_EMAIL]123'],
    ['alice@example.com.foo1', '[REDACTED_EMAIL]1'],
    ['alice@example.xn--p1ai', '[REDACTED_EMAIL]--p1ai'],
    ['alice@example.com...next', '[REDACTED_EMAIL]...next'],
  ])(
    'redacts the valid email prefix when domain-like suffix data follows: %s',
    (value, expected) => {
      const result = sanitizeSentryEvent({
        contexts: { react: { componentStack: `Widget ${value}` } },
      });

      expect(result.contexts).toEqual({
        react: { componentStack: `Widget ${expected}` },
      });
    },
  );

  it('redacts multiple email addresses in one value', () => {
    const result = sanitizeSentryEvent({
      contexts: {
        react: { componentStack: 'alice@example.com followed by bob@example.org' },
      },
    });

    expect(result.contexts).toEqual({
      react: {
        componentStack: '[REDACTED_EMAIL] followed by [REDACTED_EMAIL]',
      },
    });
  });

  it('redacts compound secret labels and the complete Authorization credential', () => {
    const result = sanitizeSentryEvent({
      request: {
        url: 'https://app.dayopt.app/debug/client_secret=short-secret',
      },
      tags: {
        route: '/debug/access_token=short-access-token',
      },
      contexts: {
        react: {
          componentStack: 'Widget api_key=short-api-key authorization: Bearer short-bearer-token',
        },
      },
    });

    expect(result).toEqual({
      request: { url: 'https://app.dayopt.app/debug/client_secret%3D[REDACTED]' },
      tags: { route: '/debug/access_token%3D[REDACTED]' },
      contexts: {
        react: {
          componentStack: 'Widget api_key=[REDACTED] authorization: [REDACTED]',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('short-secret');
    expect(JSON.stringify(result)).not.toContain('short-access-token');
    expect(JSON.stringify(result)).not.toContain('short-api-key');
    expect(JSON.stringify(result)).not.toContain('short-bearer-token');
  });

  it('redacts quoted JSON secrets and non-hierarchical URL payloads', () => {
    const result = sanitizeSentryEvent({
      request: {
        url: 'data:application/json,{"client_secret":"short-secret"}',
      },
      tags: {
        route: '/debug/%257B%2522authorization%2522%253A%2522Bearer%2520short-bearer%2522%257D',
      },
      breadcrumbs: [
        {
          data: { url: 'blob:https://app.dayopt.app/private?access_token=short-access' },
        },
      ],
      contexts: {
        react: {
          componentStack:
            'Widget {"client_secret":"short-secret","authorization":"Bearer short-bearer"}',
        },
      },
    });

    expect(result.request).toEqual({ url: '[REDACTED]' });
    expect(result.breadcrumbs).toEqual([{ data: { url: '[REDACTED]' } }]);
    expect(JSON.stringify(result)).not.toContain('short-secret');
    expect(JSON.stringify(result)).not.toContain('short-bearer');
    expect(JSON.stringify(result)).not.toContain('short-access');
  });

  it('keeps exception type and stack locations without user-controlled messages or URL queries', () => {
    const result = sanitizeSentryEvent({
      message: 'OAuth failed with code=123456 for a private contact message',
      exception: {
        values: [
          {
            type: 'AuthCallbackError',
            value: 'alice@example.com entered code=123456 and private feedback',
            stacktrace: {
              frames: [
                {
                  filename: 'https://app.dayopt.app/auth/callback?code=oauth-secret',
                  abs_path: 'https://app.dayopt.app/auth/callback?code=oauth-secret#fragment',
                  function: 'handleCallback',
                  lineno: 42,
                  colno: 7,
                  context_line: 'const code = "oauth-secret"',
                  vars: { code: 'oauth-secret' },
                },
              ],
            },
            mechanism: {
              type: 'generic',
              handled: true,
              data: { code: 'oauth-secret' },
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      message: '[REDACTED]',
      exception: {
        values: [
          {
            type: 'AuthCallbackError',
            value: '[REDACTED]',
            stacktrace: {
              frames: [
                {
                  filename: 'https://app.dayopt.app/auth/callback',
                  abs_path: 'https://app.dayopt.app/auth/callback',
                  function: 'handleCallback',
                  lineno: 42,
                  colno: 7,
                },
              ],
            },
            mechanism: { type: 'generic', handled: true },
          },
        ],
      },
    });
  });

  it('uses fixed allowlists for extra, tags, and custom contexts', () => {
    const requestId = `request-${'a'.repeat(40)}`;
    const result = sanitizeSentryEvent({
      extra: {
        feature: 'calendar',
        operation: 'load',
        requestId,
        contactMessage: 'private feedback',
        arbitrary: 'not allowed',
      },
      tags: {
        source: 'trpc',
        route: '/day?search=private',
        requestId,
        customerId: 'customer-secret',
      },
      contexts: {
        auth: { token: 'secret', email: 'alice@example.com' },
        arbitrary: { feature: 'must-not-pass' },
        react: {
          componentStack: 'Calendar > Grid at https://app.dayopt.app/auth/callback?code=123456',
          message: 'private message',
        },
      },
    });

    expect(result.extra).toEqual({ feature: 'calendar', operation: 'load', requestId });
    expect(result.tags).toEqual({ source: 'trpc', route: '/day', requestId });
    expect(result.contexts).toEqual({
      react: { componentStack: 'Calendar > Grid at https://app.dayopt.app/auth/callback' },
    });
  });

  it('accepts only typed technical leaves and drops ambiguous codes or nested content', () => {
    const result = sanitizeTechnicalContext({
      component: {
        note: 'meet me at noon',
        authCode: '123456',
      },
      code: '123456',
      errorCode: 'INTERNAL_SERVER_ERROR',
      count: 3,
      attempt: '3',
    });

    expect(result).toEqual({ errorCode: 'INTERNAL_SERVER_ERROR', count: 3 });
    expect(JSON.stringify(result)).not.toContain('123456');
    expect(JSON.stringify(result)).not.toContain('meet me at noon');
  });

  it('keeps an internal connection id and failure count, but drops non-UUID connection ids (#2687)', () => {
    const connectionId = '6F9619FF-8B86-D011-B42D-00CF4FC964FF';
    expect(sanitizeTechnicalContext({ connectionId, consecutiveFailures: 6 })).toEqual({
      connectionId: connectionId.toLowerCase(),
      consecutiveFailures: 6,
    });

    const leaked = sanitizeTechnicalContext({
      connectionId: 'someone@example.com',
      consecutiveFailures: '6',
    });
    expect(leaked).toEqual({});
    expect(JSON.stringify(leaked)).not.toContain('example.com');
  });

  it('drops an arbitrary deep subtree instead of returning any original leaf', () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 10; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.value = 'deep-secret@example.com';

    const result = sanitizeTechnicalContext({ component: root });
    expect(result).toEqual({});
  });

  it('does not treat a protocol-shaped key in a deep arbitrary subtree as protocol metadata', () => {
    const fakeTraceId = 'a'.repeat(32);
    const result = sanitizeTechnicalContext({
      component: {
        nested: {
          child: {
            trace_id: fakeTraceId,
          },
        },
      },
    });

    expect(JSON.stringify(result)).not.toContain(fakeTraceId);
    expect(result).toEqual({});
  });

  // #2289 round 4 (Codex P1): errorMessage carries free-text RPC/gateway error text.
  // sanitizeString is a denylist and is unsafe for arbitrary free text — unlabeled
  // short tokens, UUIDs, values quoted by cast errors, and credentials embedded in
  // gateway diagnostics all slip through it. errorMessage therefore uses a
  // default-closed allowlist sanitizer instead: only messages matching a known-safe
  // static pattern pass through (with sanitizeString + 200-char truncation applied on
  // top as belt-and-braces); everything else collapses to a fixed constant, with no
  // content sent at all.
  describe('errorMessage technical context (#2289 round 4, default-closed allowlist)', () => {
    it('passes through a known-safe static message unchanged (service role check)', () => {
      const result = sanitizeTechnicalContext({
        errorMessage: 'Access denied: service role required',
      });

      expect(result).toEqual({ errorMessage: 'Access denied: service role required' });
    });

    it('passes through a known-safe static message unchanged (deadlock, 40P01)', () => {
      const result = sanitizeTechnicalContext({ errorMessage: 'deadlock detected' });

      expect(result).toEqual({ errorMessage: 'deadlock detected' });
    });

    it('passes through permission denied for function, with an identifier-charset function name', () => {
      const result = sanitizeTechnicalContext({
        errorMessage: 'permission denied for function begin_calendar_sync_run_v1',
      });

      expect(result).toEqual({
        errorMessage: 'permission denied for function begin_calendar_sync_run_v1',
      });
    });

    it('passes through lock-not-available (55P03) with an identifier-charset relation name', () => {
      const result = sanitizeTechnicalContext({
        errorMessage: 'could not obtain lock on row in relation "external_calendar_events"',
      });

      expect(result).toEqual({
        errorMessage: 'could not obtain lock on row in relation "external_calendar_events"',
      });
    });

    it('collapses a cast error that quotes the raw input value to the unrecognized constant', () => {
      // Intentionally NOT allowlisted: the message tail quotes caller-controlled
      // input verbatim. The caller should identify this case via SQLSTATE 22007
      // (errorCode), not via errorMessage content.
      const result = sanitizeTechnicalContext({
        errorMessage: 'invalid input syntax for type timestamp with time zone: "2026-13-99 evil"',
      });

      expect(result).toEqual({ errorMessage: '[UNRECOGNIZED_ERROR_MESSAGE]' });
      expect(JSON.stringify(result)).not.toContain('2026-13-99 evil');
    });

    it('collapses an unknown message containing a UUID to the unrecognized constant', () => {
      const result = sanitizeTechnicalContext({
        errorMessage: 'Key (connection_id)=(11111111-1111-4111-8111-111111111111) already exists.',
      });

      expect(result).toEqual({ errorMessage: '[UNRECOGNIZED_ERROR_MESSAGE]' });
      expect(JSON.stringify(result)).not.toContain('11111111-1111-4111-8111-111111111111');
    });

    it('collapses a gateway-style HTML/long-text diagnostic to the unrecognized constant', () => {
      const gatewayHtml =
        '<html><head><title>504 Gateway Time-out</title></head><body>' +
        'The server is temporarily unable to service your request due to maintenance ' +
        'downtime or capacity problems. Please try again later. Reference: 0x' +
        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4</body></html>';

      const result = sanitizeTechnicalContext({ errorMessage: gatewayHtml });

      expect(result).toEqual({ errorMessage: '[UNRECOGNIZED_ERROR_MESSAGE]' });
      expect(JSON.stringify(result)).not.toContain('Gateway Time-out');
    });

    it('truncates a passed-through allowlisted message to the 200-char Sentry tag value limit', () => {
      // A single long identifier (e.g. a 220-char function name) would itself be
      // caught by sanitizeString's own 32+-char token redaction before truncation
      // ever runs, making it unsuitable for isolating truncation behavior. The
      // PGRST202 pattern's charset ([A-Za-z0-9_.(), =>]) includes spaces and commas,
      // so a long multi-parameter function signature can exceed 200 chars overall
      // while every individual identifier segment stays well under the 32-char
      // LONG_TOKEN_RE threshold — that isolates truncation from token redaction.
      const params = Array.from({ length: 12 }, (_, index) => `p_param_${index} => text`).join(
        ', ',
      );
      const longMessage = `Could not find the function begin_calendar_sync_run_v1(${params}) in the schema cache`;
      expect(longMessage.length).toBeGreaterThan(200);

      const result = sanitizeTechnicalContext({ errorMessage: longMessage });

      expect(result.errorMessage).toHaveLength(200);
      expect(result.errorMessage).toBe(longMessage.slice(0, 200));
    });
  });

  it('drops malformed object leaves from headers, tags, contexts, and breadcrumbs', () => {
    const traceId = 'a'.repeat(32);
    const result = sanitizeSentryEvent({
      request: {
        headers: {
          Accept: { note: 'private request header' },
        },
      },
      tags: {
        feature: { note: 'private tag' },
        code: '123456',
      },
      contexts: {
        device: {
          name: { note: 'private device name' },
          online: 'private',
        },
        response: { status_code: '123456' },
        trace: {
          trace_id: traceId,
          op: { note: 'private trace operation' },
        },
      },
      breadcrumbs: [
        {
          category: { note: 'private category' },
          data: {
            component: { note: 'private breadcrumb' },
            status_code: '123456',
          },
        },
      ],
    });

    expect(result).toEqual({ contexts: { trace: { trace_id: traceId } } });
    expect(JSON.stringify(result)).not.toContain('123456');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('drops non-allowlisted top-level fields and legacy log entries', () => {
    const result = sanitizeSentryEvent({
      event_id: 'a'.repeat(32),
      logentry: { message: 'private feedback', params: ['123456'] },
      arbitrary: { contactMessage: 'private feedback' },
    });

    expect(result).toEqual({ event_id: 'a'.repeat(32) });
  });

  it('sanitizes thread stacks with the same fixed frame allowlist', () => {
    const result = sanitizeSentryEvent({
      threads: {
        values: [
          {
            id: 1,
            name: 'main',
            stacktrace: {
              frames: [
                {
                  filename: 'https://app.dayopt.app/auth/callback?code=private',
                  lineno: 12,
                  context_line: 'const code = "private"',
                  vars: { code: 'private' },
                },
              ],
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      threads: {
        values: [
          {
            id: 1,
            name: 'main',
            stacktrace: {
              frames: [{ filename: 'https://app.dayopt.app/auth/callback', lineno: 12 }],
            },
          },
        ],
      },
    });
  });

  it('keeps only safe dynamic sampling fields and strips its transaction query', () => {
    const traceId = 'a'.repeat(32);
    const publicKey = 'b'.repeat(32);
    const result = sanitizeSentryEvent({
      sdkProcessingMetadata: {
        dynamicSamplingContext: {
          trace_id: traceId,
          public_key: publicKey,
          release: 'c'.repeat(40),
          environment: 'production',
          sampled: 'true',
          transaction: '/auth/callback?code=private',
          privateField: 'private feedback',
        },
        spanCountBeforeProcessing: 3,
        normalizedRequest: { data: { contactMessage: 'private feedback' } },
        ipAddress: '127.0.0.1',
        capturedSpanScope: { private: 'scope' },
      },
    });

    expect(result).toEqual({
      sdkProcessingMetadata: {
        dynamicSamplingContext: {
          trace_id: traceId,
          public_key: publicKey,
          release: 'c'.repeat(40),
          environment: 'production',
          sampled: 'true',
          transaction: '/auth/callback',
        },
        spanCountBeforeProcessing: 3,
      },
    });
  });

  it('preserves debug IDs required for source-map symbolication and sanitizes code URLs', () => {
    const debugId = '12345678-1234-1234-1234-123456789abc';
    const result = sanitizeSentryEvent({
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            debug_id: debugId,
            code_file: 'https://app.dayopt.app/_next/static/chunks/app.js?build=private',
            privateField: 'private feedback',
          },
        ],
      },
    });

    expect(result).toEqual({
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            debug_id: debugId,
            code_file: 'https://app.dayopt.app/_next/static/chunks/app.js',
          },
        ],
      },
    });
  });

  it('does not mutate its input', () => {
    const event = {
      message: 'alice@example.com',
      request: { url: 'https://app.dayopt.com/day?token=secret' },
    };
    const snapshot = structuredClone(event);

    sanitizeSentryEvent(event);
    expect(event).toEqual(snapshot);
  });

  it('drops malformed structured fields instead of preserving their raw value', () => {
    const result = sanitizeSentryEvent({
      request: 'raw request body',
      user: 'alice@example.com',
      extra: 'short private text',
      tags: ['private'],
      contexts: 'private',
      breadcrumbs: 'private',
    });

    expect(result).toEqual({});
  });
});

describe('transaction, span, and breadcrumb sanitizers', () => {
  it('removes query data from transaction names', () => {
    expect(
      sanitizeSentryTransaction({ transaction: '/api/trpc/plans.list?input=private' }).transaction,
    ).toBe('/api/trpc/plans.list');
  });

  it('preserves correlation IDs in transaction spans and span links', () => {
    const traceId = '1'.repeat(32);
    const spanId = '2'.repeat(16);
    const parentSpanId = '3'.repeat(16);
    const linkedTraceId = '4'.repeat(32);

    const result = sanitizeSentryTransaction({
      transaction: '/api/trpc/calendar.list',
      spans: [
        {
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          links: [{ trace_id: linkedTraceId, span_id: spanId }],
        },
      ],
    });

    expect(result.spans).toEqual([
      {
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        links: [{ trace_id: linkedTraceId, span_id: spanId }],
      },
    ]);
  });

  it('drops arbitrary span-link attributes and streamed span names', () => {
    const result = sanitizeSentrySpan({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      name: 'private search phrase',
      links: [
        {
          trace_id: 'c'.repeat(32),
          span_id: 'd'.repeat(16),
          sampled: true,
          attributes: {
            'sentry.link.type': 'previous_trace',
            contactMessage: 'private feedback',
          },
        },
      ],
    });

    expect(result).toEqual({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      name: '[REDACTED]',
      links: [
        {
          trace_id: 'c'.repeat(32),
          span_id: 'd'.repeat(16),
          sampled: true,
          attributes: { 'sentry.link.type': 'previous_trace' },
        },
      ],
    });
  });

  it('preserves span correlation IDs while allowing only technical attributes', () => {
    const traceId = '1'.repeat(32);
    const result = sanitizeSentrySpan({
      trace_id: traceId,
      span_id: '2'.repeat(16),
      description: 'GET https://app.dayopt.com/day?search=private',
      data: {
        'http.request.method': 'GET',
        'url.full': 'https://app.dayopt.com/day?search=private',
        'db.query.text': 'select private_data from users',
        customerEmail: 'alice@example.com',
      },
    });

    expect(result.trace_id).toBe(traceId);
    expect(result.description).toBe('GET https://app.dayopt.com/day');
    expect(result.data).toEqual({
      'http.request.method': 'GET',
      'url.full': 'https://app.dayopt.com/day',
    });
  });

  it('drops arbitrary short values even when they use a telemetry prefix', () => {
    const result = sanitizeSentrySpan({
      data: {
        'http.note': 'please call me tonight',
        'rpc.metadata': { note: 'private feedback' },
        'http.request.method': 'POST',
      },
    });

    expect(result).toEqual({ data: { 'http.request.method': 'POST' } });
  });

  it('redacts arbitrary span descriptions such as SQL and contact text', () => {
    expect(
      sanitizeSentrySpan({
        op: 'db.query',
        description: "select * from users where email = 'alice@example.com'",
      }).description,
    ).toBe('[REDACTED]');
    expect(
      sanitizeSentrySpan({ op: 'function', description: 'feedback: please call me tonight' })
        .description,
    ).toBe('[REDACTED]');
  });

  it('drops malformed span data instead of retaining arbitrary values', () => {
    expect(
      sanitizeSentrySpan({
        data: 'contact me at alice@example.com',
        attributes: ['private search term'],
      }),
    ).toEqual({});
  });

  it('keeps breadcrumb classification but strips arbitrary data and URL queries', () => {
    const result = sanitizeSentryBreadcrumb({
      category: 'http',
      message: 'request for alice@example.com',
      data: {
        method: 'GET',
        url: 'https://app.dayopt.com/day?token=secret',
        responseBody: 'private',
      },
    });

    expect(result).toEqual({
      category: 'http',
      message: '[REDACTED]',
      data: { method: 'GET', url: 'https://app.dayopt.com/day' },
    });
  });

  it('drops console breadcrumbs that stringify arbitrary arguments', () => {
    expect(
      sanitizeSentryBreadcrumb({
        category: 'console',
        message: 'Contact payload: short private text',
        data: { arguments: ['short private text'] },
      }),
    ).toBeNull();
  });
});
