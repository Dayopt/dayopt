/**
 * `send-auth-email` の失敗分類と Sentry envelope 組み立て（#2682）。
 *
 * 従来は署名不一致・Resend 停止・Resend 4xx・render 失敗をすべて HTTP 401 に畳んでおり、
 * Resend の availability 失敗が GoTrue には「unauthorized」に見えていた。ここでは
 * `supabase/functions/send-auth-email/failure.ts`（HTTP status / capture 可否の分類）と
 * `supabase/functions/_shared/sentry.ts`（DSN 未投入時の no-op を含む envelope 送信）の
 * 契約を固定する。どちらも Deno API に一切触れない純関数で、`index.ts` は module scope で
 * `Deno.env.get` を呼ぶため import できない（先例は `send-auth-email-confirm-url.test.ts`）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildSentryEnvelope,
  captureEdgeFunctionEvent,
  parseSentryDsn,
} from '../../supabase/functions/_shared/sentry.ts';
import {
  classifySendAuthEmailFailure,
  resolveSendAuthEmailStatus,
} from '../../supabase/functions/send-auth-email/failure.ts';

describe('classifySendAuthEmailFailure', () => {
  it('WebhookVerificationError は 401 signature（phase を問わない）', () => {
    const error = Object.assign(new Error('signature mismatch'), {
      name: 'WebhookVerificationError',
    });

    const result = classifySendAuthEmailFailure(error, 'send');

    expect(result.status).toBe(401);
    expect(result.kind).toBe('signature');
  });

  it('phase verify は 401 signature', () => {
    const result = classifySendAuthEmailFailure(new Error('bad payload'), 'verify');

    expect(result.status).toBe(401);
    expect(result.kind).toBe('signature');
  });

  it.each([
    ['internal_server_error'],
    ['application_error'],
    ['rate_limit_exceeded'],
    ['daily_quota_exceeded'],
    ['monthly_quota_exceeded'],
  ])('Resend の %s は 503 resend_unavailable（GoTrue の再試行に載せる）', (name) => {
    const result = classifySendAuthEmailFailure({ name, message: 'resend down' }, 'send');

    expect(result.status).toBe(503);
    expect(result.kind).toBe('resend_unavailable');
    expect(result.resendErrorName).toBe(name);
  });

  it('Resend の validation_error は 500 resend_rejected で resendErrorName を保持する', () => {
    const result = classifySendAuthEmailFailure(
      { name: 'validation_error', message: 'bad from address' },
      'send',
    );

    expect(result.status).toBe(500);
    expect(result.kind).toBe('resend_rejected');
    expect(result.resendErrorName).toBe('validation_error');
  });

  it('render phase の Error は 500 render', () => {
    const result = classifySendAuthEmailFailure(new Error('render exploded'), 'render');

    expect(result.status).toBe(500);
    expect(result.kind).toBe('render');
    expect(result.resendErrorName).toBeUndefined();
  });

  it('send phase の plain string error は 500 unknown', () => {
    const result = classifySendAuthEmailFailure('boom', 'send');

    expect(result.status).toBe(500);
    expect(result.kind).toBe('unknown');
  });

  it('message に含まれる email は redact する', () => {
    const result = classifySendAuthEmailFailure(
      new Error('failed to deliver to user@example.com'),
      'send',
    );

    expect(result.message).not.toContain('user@example.com');
    expect(result.message).toContain('[redacted-email]');
  });
});

describe('parseSentryDsn', () => {
  it('valid DSN を envelope URL と public key へ分解する', () => {
    const result = parseSentryDsn('https://abc123@o0.ingest.sentry.io/123');

    expect(result).toEqual({
      envelopeUrl: 'https://o0.ingest.sentry.io/api/123/envelope/',
      publicKey: 'abc123',
    });
  });

  it('不正な DSN は null', () => {
    expect(parseSentryDsn('not-a-url')).toBeNull();
    expect(parseSentryDsn('https://o0.ingest.sentry.io/123')).toBeNull(); // key 無し
    expect(parseSentryDsn('https://abc123@o0.ingest.sentry.io/')).toBeNull(); // projectId 無し
  });
});

describe('buildSentryEnvelope', () => {
  const dsn = 'https://abc123@o0.ingest.sentry.io/123';
  const now = new Date('2026-09-10T00:00:00.000Z');

  it('3 行の newline 区切り JSON と /api/123/envelope/ で終わる url を返す', () => {
    const envelope = buildSentryEnvelope(
      dsn,
      {
        functionName: 'send-auth-email',
        message: 'send-auth-email failed: resend_unavailable',
        tags: { action: 'signup', phase: 'send', kind: 'resend_unavailable', status: '503' },
        extra: { subject: 'Confirm your email' },
      },
      now,
    );

    expect(envelope).not.toBeNull();
    expect(envelope!.url).toBe('https://o0.ingest.sentry.io/api/123/envelope/');

    const lines = envelope!.body.split('\n');
    expect(lines).toHaveLength(3);
    lines.forEach((line) => expect(() => JSON.parse(line)).not.toThrow());

    const [envelopeHeader, itemHeader, eventPayload] = lines.map((line) => JSON.parse(line));
    expect(envelopeHeader.dsn).toBe(dsn);
    expect(itemHeader).toEqual({ type: 'event' });
    expect(eventPayload.message).toBe('send-auth-email failed: resend_unavailable');
    expect(eventPayload.tags.kind).toBe('resend_unavailable');
  });

  it('extra に subject しか含めなければ、宛先 email 文字列は body に含まれない', () => {
    const targetEmail = 'user@example.com';
    const envelope = buildSentryEnvelope(
      dsn,
      {
        functionName: 'send-auth-email',
        message: 'send-auth-email failed: render',
        tags: { action: 'signup', phase: 'render', kind: 'render', status: '500' },
        extra: { subject: 'Confirm your email' },
      },
      now,
    );

    expect(envelope!.body).not.toContain(targetEmail);
  });

  it('不正な DSN では null を返す', () => {
    expect(
      buildSentryEnvelope('not-a-dsn', {
        functionName: 'send-auth-email',
        message: 'x',
        tags: {},
      }),
    ).toBeNull();
  });
});

describe('captureEdgeFunctionEvent', () => {
  const event = {
    functionName: 'send-auth-email',
    message: 'send-auth-email failed: unknown',
    tags: { action: 'signup', phase: 'send', kind: 'unknown', status: '500' },
  };

  it('DSN が undefined なら fetch を一切呼ばない', async () => {
    const fetchImpl = vi.fn();

    await captureEdgeFunctionEvent(undefined, event, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('DSN があれば envelope を 1 回だけ POST する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await captureEdgeFunctionEvent('https://abc123@o0.ingest.sentry.io/123', event, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://o0.ingest.sentry.io/api/123/envelope/');
    expect(init.method).toBe('POST');
  });

  it('fetch が reject しても throw しない', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      captureEdgeFunctionEvent('https://abc123@o0.ingest.sentry.io/123', event, fetchImpl),
    ).resolves.toBeUndefined();
  });
});

describe('classifySendAuthEmailFailure: 組み込み Error の name を Resend error code と混同しない', () => {
  it('send phase で throw された素の Error は 500 unknown（resend_error tag を汚さない）', () => {
    const result = classifySendAuthEmailFailure(new TypeError('fetch failed'), 'send');

    expect(result.status).toBe(500);
    expect(result.kind).toBe('unknown');
    expect(result.resendErrorName).toBeUndefined();
  });
});

describe('buildSentryEnvelope: environment', () => {
  it('既定で production を載せる（Sentry の environment 絞り込みから漏れないため）', () => {
    const envelope = buildSentryEnvelope('https://key@o1.ingest.sentry.io/123', {
      functionName: 'send-auth-email',
      message: 'send-auth-email failed: resend_unavailable',
      tags: { kind: 'resend_unavailable' },
    });

    expect(envelope).not.toBeNull();
    const eventLine = JSON.parse(envelope!.body.split('\n')[2]!);
    expect(eventLine.environment).toBe('production');
    expect(eventLine.tags.function).toBe('send-auth-email');
  });
});

describe('captureEdgeFunctionEvent: Auth Hook の 5 秒予算を守る', () => {
  it('POST に abort signal を渡し、hook 全体を timeout させない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await captureEdgeFunctionEvent(
      'https://abc123@o0.ingest.sentry.io/123',
      {
        functionName: 'send-auth-email',
        message: 'send-auth-email failed: resend_unavailable',
        tags: { kind: 'resend_unavailable' },
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('abort された fetch でも throw しない', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    await expect(
      captureEdgeFunctionEvent(
        'https://abc123@o0.ingest.sentry.io/123',
        {
          functionName: 'send-auth-email',
          message: 'x',
          tags: {},
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('resolveSendAuthEmailStatus: 部分送信からの再試行を止める', () => {
  const unavailable = classifySendAuthEmailFailure({ name: 'internal_server_error' }, 'send');

  it('1 通も送れていなければ 503 のまま GoTrue の再試行に載せる', () => {
    expect(resolveSendAuthEmailStatus(unavailable, { firstEmailAlreadySent: false })).toBe(503);
  });

  it('email_change の 2 通目失敗では 500 へ落とす（1 通目の重複配送を防ぐ）', () => {
    expect(resolveSendAuthEmailStatus(unavailable, { firstEmailAlreadySent: true })).toBe(500);
  });

  it('もともと non-retryable な失敗は部分送信の有無で変わらない', () => {
    const rejected = classifySendAuthEmailFailure({ name: 'validation_error' }, 'send');
    const signature = classifySendAuthEmailFailure(new Error('bad'), 'verify');

    expect(resolveSendAuthEmailStatus(rejected, { firstEmailAlreadySent: true })).toBe(500);
    expect(resolveSendAuthEmailStatus(signature, { firstEmailAlreadySent: true })).toBe(401);
  });
});
