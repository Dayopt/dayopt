import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';
import { resetWebhookSignatureFailureCaptureForTestsOnly } from '@/lib/webhooks/signature-failure-monitor';

const mocks = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
  createServiceRoleClient: vi.fn(),
  captureUnexpectedDatabaseError: vi.fn(),
  captureUnexpectedError: vi.fn(),
  claimResendWebhookEvent: vi.fn(),
  completeResendWebhookEvent: vi.fn(),
  releaseResendWebhookEvent: vi.fn(),
  hashRateLimitIdentifier: vi.fn(),
  useSupabaseWebhookClaimPoc: false,
  claimSupabaseWebhookEventPoc: vi.fn(),
  completeSupabaseWebhookEventPoc: vi.fn(),
  releaseSupabaseWebhookEventPoc: vi.fn(),
  writeFenceMaybeSingle: vi.fn(),
  env: {
    RESEND_API_KEY: 'test-key' as string | undefined,
    RESEND_WEBHOOK_SECRET: 'test-secret' as string | undefined,
  },
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

/**
 * fence check は claim より前に必ず write_fence_control を読む。他テーブル向けの
 * from() 実装（upsert 等）を保ったまま、fence だけ既定で disabled を返す table-aware
 * mock を組み立てる。
 */
function fromWithWriteFence(otherTableFrom: (table: string) => unknown) {
  return vi.fn((table: string) =>
    table === 'write_fence_control'
      ? { select: () => ({ eq: () => ({ maybeSingle: mocks.writeFenceMaybeSingle }) }) }
      : otherTableFrom(table),
  );
}

vi.mock('resend', () => ({
  Resend: class MockResend {
    webhooks = { verify: mocks.verifyWebhook };
  },
}));
vi.mock('@/env', () => ({ env: mocks.env }));
vi.mock('@/lib/logger', () => ({ logger: mocks.logger }));
vi.mock('@/lib/rate-limit/upstash', () => ({
  claimResendWebhookEvent: mocks.claimResendWebhookEvent,
  completeResendWebhookEvent: mocks.completeResendWebhookEvent,
  hashRateLimitIdentifier: mocks.hashRateLimitIdentifier,
  releaseResendWebhookEvent: mocks.releaseResendWebhookEvent,
}));
vi.mock('@/lib/rate-limit/supabase-poc', () => ({
  isSupabaseWebhookClaimPocEnabled: () => mocks.useSupabaseWebhookClaimPoc,
  claimSupabaseWebhookEventPoc: mocks.claimSupabaseWebhookEventPoc,
  completeSupabaseWebhookEventPoc: mocks.completeSupabaseWebhookEventPoc,
  releaseSupabaseWebhookEventPoc: mocks.releaseSupabaseWebhookEventPoc,
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: mocks.captureUnexpectedDatabaseError,
  captureUnexpectedError: mocks.captureUnexpectedError,
}));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { POST } from './route';

function request(body = '{}'): NextRequest {
  return new NextRequest('https://app.dayopt.app/api/webhooks/resend', {
    method: 'POST',
    body,
    headers: {
      'svix-id': 'event-1',
      'svix-timestamp': '123',
      'svix-signature': 'signature',
    },
  });
}

describe('Product Resend webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.RESEND_WEBHOOK_SECRET = 'test-secret';
    mocks.claimResendWebhookEvent.mockResolvedValue({ status: 'claimed', token: 'lease-1' });
    mocks.completeResendWebhookEvent.mockResolvedValue(undefined);
    mocks.releaseResendWebhookEvent.mockResolvedValue(undefined);
    mocks.hashRateLimitIdentifier.mockResolvedValue('b'.repeat(64));
    mocks.useSupabaseWebhookClaimPoc = false;
    mocks.claimSupabaseWebhookEventPoc.mockResolvedValue('claimed');
    mocks.completeSupabaseWebhookEventPoc.mockResolvedValue(true);
    mocks.releaseSupabaseWebhookEventPoc.mockResolvedValue(true);
    mocks.writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: false }, error: null });
    mocks.createServiceRoleClient.mockReturnValue({
      from: fromWithWriteFence(() => undefined),
    });
    resetWriteFenceCacheForTestsOnly();
    resetWebhookSignatureFailureCaptureForTestsOnly();
    mocks.captureUnexpectedDatabaseError.mockImplementation((error: unknown) =>
      error instanceof Error ? error : new Error('Unexpected database failure', { cause: error }),
    );
  });

  it('records transactional bounce suppression with the schema unique key', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocks.createServiceRoleClient.mockReturnValue({ from: fromWithWriteFence(() => ({ upsert })) });
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-1' },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      {
        email: 'private@example.com',
        reason: 'bounce',
        source_event_id: 'email-1',
      },
      { onConflict: 'email,reason' },
    );
    expect(JSON.stringify(mocks.logger)).not.toContain('private@example.com');
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
  });

  it('transient bounce（mailbox full 等）では suppression を書かない', async () => {
    // Resend の email.bounced は data.bounce.type に permanent / transient / undetermined を
    // 載せる（resend SDK `EmailBouncedEvent`）。transient を恒久 suppression にすると、
    // 解除経路が無いためその address 宛の transactional mail が永久に止まる。
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocks.createServiceRoleClient.mockReturnValue({ from: fromWithWriteFence(() => ({ upsert })) });
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: {
        to: ['private@example.com'],
        email_id: 'email-transient',
        bounce: { type: 'transient', subType: 'MailboxFull', message: 'mailbox full' },
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger)).not.toContain('private@example.com');
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
  });

  it.each(['permanent', 'undetermined', 'Permanent'])(
    'bounce.type=%s は suppression を書く（undetermined は保守的に suppress）',
    async (type) => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      mocks.createServiceRoleClient.mockReturnValue({
        from: fromWithWriteFence(() => ({ upsert })),
      });
      mocks.verifyWebhook.mockReturnValue({
        type: 'email.bounced',
        data: {
          to: ['private@example.com'],
          email_id: 'email-hard',
          bounce: { type, subType: 'General', message: 'no such user' },
        },
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'private@example.com', reason: 'bounce' }),
        { onConflict: 'email,reason' },
      );
    },
  );

  it('captures a suppression DB failure once without address PII and releases the lease', async () => {
    const dbError = { code: 'PGRST500', message: 'database unavailable' };
    const upsert = vi.fn().mockResolvedValue({ error: dbError });
    mocks.createServiceRoleClient.mockReturnValue({ from: fromWithWriteFence(() => ({ upsert })) });
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.complained',
      data: { to: ['private@example.com'], email_id: 'email-2' },
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledWith(dbError, {
      feature: 'email',
      operation: 'record_email_suppression',
      route: '/api/webhooks/resend',
      requestId: 'email-2',
    });
    expect(mocks.captureUnexpectedError).not.toHaveBeenCalled();
    expect(mocks.releaseResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain('private@example.com');
  });

  it.each(['email.bounced', 'email.complained', 'email.failed', 'email.suppressed'] as const)(
    'captures Product contact %s without adding support to suppression',
    async (type) => {
      const upsert = vi.fn();
      mocks.createServiceRoleClient.mockReturnValue({
        from: fromWithWriteFence(() => ({ upsert })),
      });
      mocks.verifyWebhook.mockReturnValue({
        type,
        data: {
          to: ['support@dayopt.app'],
          email_id: 'contact-email-1',
          tags: { source: 'contact-product', category: 'question' },
        },
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(upsert).not.toHaveBeenCalled();
      expect(mocks.captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
        feature: 'contact',
        operation: 'email_delivery_status',
        route: '/api/webhooks/resend',
        source: 'resend_webhook',
        requestId: 'contact-email-1',
      });
      expect(JSON.stringify(mocks.captureUnexpectedError.mock.calls)).not.toContain(
        'support@dayopt.app',
      );
      expect(mocks.completeResendWebhookEvent.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.captureUnexpectedError.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('retries a contact terminal-marker failure without duplicating the delivery Issue', async () => {
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.failed',
      data: {
        to: ['support@dayopt.app'],
        email_id: 'contact-email-retry',
        tags: { source: 'contact-product' },
      },
    });
    mocks.completeResendWebhookEvent
      .mockRejectedValueOnce(new Error('complete failed'))
      .mockResolvedValueOnce(undefined);

    expect((await POST(request())).status).toBe(500);
    expect(mocks.releaseResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
    const deliveryCapturesAfterFailure = mocks.captureUnexpectedError.mock.calls.filter(
      ([, context]) => context.operation === 'email_delivery_status',
    );
    expect(deliveryCapturesAfterFailure).toHaveLength(0);

    expect((await POST(request())).status).toBe(200);
    const deliveryCapturesAfterRetry = mocks.captureUnexpectedError.mock.calls.filter(
      ([, context]) => context.operation === 'email_delivery_status',
    );
    expect(deliveryCapturesAfterRetry).toHaveLength(1);
  });

  it('leaves Web contact events to the Web-specific endpoint', async () => {
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: {
        to: ['support@dayopt.app'],
        email_id: 'web-contact-email-1',
        tags: { source: 'contact-web' },
      },
    });

    expect((await POST(request())).status).toBe(200);
    expect(mocks.claimResendWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.captureUnexpectedError).not.toHaveBeenCalled();
  });

  it('acknowledges completed duplicates and returns 503 for an active lease', async () => {
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { to: ['private@example.com'], email_id: 'email-duplicate' },
    });
    mocks.claimResendWebhookEvent.mockResolvedValueOnce({ status: 'already_processed' });
    expect((await POST(request())).status).toBe(200);

    mocks.claimResendWebhookEvent.mockResolvedValueOnce({ status: 'in_progress' });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.completeResendWebhookEvent).not.toHaveBeenCalled();
  });

  it('uses Supabase claims and preserves the Upstash compatibility marker on Integration', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-poc' },
    });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.hashRateLimitIdentifier).toHaveBeenCalledWith('resend-event:event-1');
    expect(mocks.claimSupabaseWebhookEventPoc).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: expect.any(Function) }),
      'b'.repeat(64),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    expect(mocks.completeSupabaseWebhookEventPoc).toHaveBeenCalledWith(
      expect.anything(),
      'b'.repeat(64),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    expect(mocks.claimResendWebhookEvent).toHaveBeenCalledWith('event-1');
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('honors an existing completed Upstash marker before claiming in Supabase', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-old-duplicate' },
    });
    const upsert = vi.fn();
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });
    mocks.claimResendWebhookEvent.mockResolvedValueOnce({ status: 'already_processed' });

    expect((await POST(request())).status).toBe(200);
    expect(mocks.claimSupabaseWebhookEventPoc).not.toHaveBeenCalled();
    expect(mocks.completeSupabaseWebhookEventPoc).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not bypass an Upstash lease held by a pre-cutover delivery', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-old-in-progress' },
    });
    const upsert = vi.fn();
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });
    mocks.claimResendWebhookEvent.mockResolvedValueOnce({ status: 'in_progress' });

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.claimSupabaseWebhookEventPoc).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not run webhook effects when the Supabase claim is already processed or unavailable', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-poc-duplicate' },
    });
    const upsert = vi.fn();
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });
    mocks.claimSupabaseWebhookEventPoc.mockResolvedValueOnce('already_processed');

    expect((await POST(request())).status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.completeSupabaseWebhookEventPoc).not.toHaveBeenCalled();
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
    expect(mocks.releaseResendWebhookEvent).not.toHaveBeenCalled();

    mocks.claimSupabaseWebhookEventPoc.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await POST(request())).status).toBe(500);
    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.releaseResendWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps the Upstash lease when promoting an already-processed Supabase event fails', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { to: ['private@example.com'], email_id: 'email-poc-terminal-promotion' },
    });
    mocks.claimSupabaseWebhookEventPoc.mockResolvedValueOnce('already_processed');
    mocks.completeResendWebhookEvent.mockRejectedValueOnce(new Error('Upstash unavailable'));

    expect((await POST(request())).status).toBe(500);
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
    expect(mocks.releaseResendWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.releaseSupabaseWebhookEventPoc).not.toHaveBeenCalled();
  });

  it('releases the Supabase webhook lease after a failed suppression write', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.complained',
      data: { to: ['private@example.com'], email_id: 'email-poc-failure' },
    });
    const upsert = vi.fn().mockResolvedValue({ error: { code: 'PGRST500' } });
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });

    expect((await POST(request())).status).toBe(500);
    expect(mocks.releaseSupabaseWebhookEventPoc).toHaveBeenCalledWith(
      expect.anything(),
      'b'.repeat(64),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    expect(mocks.releaseResendWebhookEvent).toHaveBeenCalledWith('event-1', 'lease-1');
  });

  it('does not repeat effects if the Supabase terminal marker succeeds before Upstash fails', async () => {
    mocks.useSupabaseWebhookClaimPoc = true;
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: { to: ['private@example.com'], email_id: 'email-poc-complete-retry' },
    });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(),
      from: fromWithWriteFence(() => ({ upsert })),
    });
    mocks.claimResendWebhookEvent
      .mockResolvedValueOnce({ status: 'claimed', token: 'lease-1' })
      .mockResolvedValueOnce({ status: 'in_progress' })
      .mockResolvedValueOnce({ status: 'claimed', token: 'lease-2' });
    mocks.claimSupabaseWebhookEventPoc
      .mockResolvedValueOnce('claimed')
      .mockResolvedValueOnce('already_processed');
    mocks.completeResendWebhookEvent.mockRejectedValueOnce(new Error('Upstash unavailable'));

    expect((await POST(request())).status).toBe(500);
    expect((await POST(request())).status).toBe(503);
    expect((await POST(request())).status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
    expect(mocks.completeSupabaseWebhookEventPoc).toHaveBeenCalledOnce();
    expect(mocks.completeResendWebhookEvent).toHaveBeenCalledTimes(2);
    expect(mocks.releaseResendWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.releaseSupabaseWebhookEventPoc).not.toHaveBeenCalled();
  });

  it('rejects missing/invalid signatures and oversized bodies before side effects', async () => {
    const missingHeaders = new NextRequest('https://app.dayopt.app/api/webhooks/resend', {
      method: 'POST',
      body: '{}',
    });
    expect((await POST(missingHeaders)).status).toBe(401);

    mocks.verifyWebhook.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const invalidResponses = await Promise.all(Array.from({ length: 5 }, () => POST(request())));
    expect(invalidResponses.every((response) => response.status === 401)).toBe(true);
    expect(mocks.captureUnexpectedError).toHaveBeenCalledOnce();
    expect(mocks.captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'email',
      operation: 'signature_verification',
      route: '/api/webhooks/resend',
      source: 'resend_webhook',
    });

    mocks.verifyWebhook.mockReset();

    const oversized = request('x');
    oversized.headers.set('content-length', String(64 * 1024 + 1));
    expect((await POST(oversized)).status).toBe(413);
    expect(mocks.claimResendWebhookEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the Product webhook secret is missing', async () => {
    mocks.env.RESEND_WEBHOOK_SECRET = undefined;
    expect((await POST(request())).status).toBe(500);
    expect(mocks.verifyWebhook).not.toHaveBeenCalled();
    expect(mocks.captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'email',
      operation: 'resend_webhook_configuration',
      route: '/api/webhooks/resend',
      source: 'resend_webhook',
    });
  });

  it('reports terminal marker and lease release failures without PII', async () => {
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { to: ['private@example.com'], email_id: 'email-3' },
    });
    mocks.completeResendWebhookEvent.mockRejectedValue(new Error('complete failed'));
    mocks.releaseResendWebhookEvent.mockRejectedValue(new Error('release failed'));

    expect((await POST(request())).status).toBe(500);
    expect(mocks.captureUnexpectedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'release failed' }),
      {
        feature: 'email',
        operation: 'resend_webhook_lease_release',
        route: '/api/webhooks/resend',
        source: 'resend_webhook',
      },
    );
    expect(JSON.stringify(mocks.captureUnexpectedError.mock.calls)).not.toContain(
      'private@example.com',
    );
  });

  it('write fence が有効な時は claim 前に 503 を返す（lease の滞留を避ける）', async () => {
    mocks.writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: true }, error: null });
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { to: ['private@example.com'], email_id: 'email-fenced' },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(mocks.claimResendWebhookEvent).not.toHaveBeenCalled();
  });

  it('Web contact の早期return分岐は書き込みが無いため fence の影響を受けない', async () => {
    mocks.writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: true }, error: null });
    mocks.verifyWebhook.mockReturnValue({
      type: 'email.bounced',
      data: {
        to: ['support@dayopt.app'],
        email_id: 'web-contact-during-fence',
        tags: { source: 'contact-web' },
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.claimResendWebhookEvent).not.toHaveBeenCalled();
  });
});
