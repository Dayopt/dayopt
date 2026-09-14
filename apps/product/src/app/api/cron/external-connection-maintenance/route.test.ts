import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchExternalConnectionMaintenance = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const writeCronHeartbeat = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const isWriteFenceEnabled = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () => ({ CRON_SECRET: 'super-secret-cron' }) as { CRON_SECRET?: string | undefined },
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('./_composition/maintenance-dispatcher', () => ({
  dispatchExternalConnectionMaintenance,
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    error: loggerError,
    warn: loggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/ops/cron-heartbeat', () => ({ writeCronHeartbeat }));
vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: vi.fn(() => ({})) }));

import type { dispatchExternalConnectionMaintenance as dispatchType } from './_composition/maintenance-dispatcher';
import { GET, maxDuration } from './route';

const URL = 'https://app.dayopt.app/api/cron/external-connection-maintenance';

/**
 * dispatcher の戻り値型で固定する。型注釈が無いと、実型に存在しないフィールド名の
 * fixture でも mock が受け取ってしまい、route 層の test が retention の shape を
 * 何もロックしない状態になる（実際に旧 fixture は実型と一度も一致していなかった）。
 */
const SUMMARY: Awaited<ReturnType<typeof dispatchType>> = {
  complete: false,
  outbox: {
    claimed: 2,
    revoked: 1,
    retried: 1,
    expired: 0,
    alreadyGone: 0,
    due: 1,
    total: 2,
    oldestDueAgeSeconds: 30,
    deferred: 1,
    revokeUnavailable: false,
  },
  retention: {
    oauthAuthorizationCodesDeleted: 1,
    oauthAccessTokensDeleted: 2,
    oauthRefreshTokensDeleted: 3,
    oauthConnectionsDeleted: 4,
    billingClaimsDeleted: 1,
    billingDeletionReceiptsDeleted: 2,
    billingProviderResponsesRedacted: 3,
    securityEventsDeleted: 6,
    mcpMutationReceiptsDeleted: 5,
    due: {
      authorizationCodes: false,
      accessTokens: false,
      refreshTokens: false,
      connections: false,
      receipts: false,
      securityEvents: false,
      billingClaims: false,
      billingDeletionReceipts: false,
    },
    hasMore: false,
  },
  calendarFinalizeStuck: 0,
  durationMs: 120,
};

function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new NextRequest(URL, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CRON_SECRET = 'super-secret-cron';
  dispatchExternalConnectionMaintenance.mockResolvedValue(SUMMARY);
  isWriteFenceEnabled.mockResolvedValue(false);
});

describe('external connection maintenance cron', () => {
  // maintenance-dispatcher.test.ts の時間予算の不変条件はこの 2 値を写して検査している
  // （route.ts を import すると mock していない依存を引き込むため）。ここで実値を pin し、
  // 片方だけ変わった時に必ず落ちるようにする。
  it('cron の時間予算を pin する', async () => {
    expect(maxDuration).toBe(60);

    const before = Date.now();
    await GET(request('Bearer super-secret-cron'));
    const after = Date.now();

    const passed = dispatchExternalConnectionMaintenance.mock.calls[0]?.[0];
    expect(passed?.deadlineAt).toBeGreaterThanOrEqual(before + 50_000);
    expect(passed?.deadlineAt).toBeLessThanOrEqual(after + 50_000);
  });

  it('CRON_SECRET未設定なら503でdispatcherを呼ばない', async () => {
    envMock.CRON_SECRET = undefined;

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(dispatchExternalConnectionMaintenance).not.toHaveBeenCalled();
  });

  it('CRON_SECRETが16文字未満なら503でdispatcherを呼ばない', async () => {
    envMock.CRON_SECRET = 'too-short';

    const response = await GET(request('Bearer too-short'));

    expect(response.status).toBe(503);
    expect(dispatchExternalConnectionMaintenance).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Bearer wrong-secret', 'super-secret-cron'])(
    'Bearer認証不一致(%s)は401',
    async (authorization) => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      expect(dispatchExternalConnectionMaintenance).not.toHaveBeenCalled();
    },
  );

  it('認証成功時はaggregate summaryだけを返す', async () => {
    const response = await GET(request('Bearer super-secret-cron'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, ...SUMMARY });
    expect(dispatchExternalConnectionMaintenance).toHaveBeenCalledWith({
      deadlineAt: expect.any(Number),
    });
    // warn には「何が残っているか」を添える。理由なしだと OAuth retention の cleanup 失敗と
    // calendar outbox の単純な滞留を区別できない。
    expect(loggerWarn).toHaveBeenCalledWith(
      '[external-connection-maintenance] work remains after dispatch',
      {
        retentionDue: SUMMARY.retention.due,
        outboxTotal: SUMMARY.outbox.total,
        outboxExpired: SUMMARY.outbox.expired,
        outboxRetried: SUMMARY.outbox.retried,
      },
    );
  });

  it('暗号鍵が使えずoutboxが残る場合はcleanup後に503を返す', async () => {
    dispatchExternalConnectionMaintenance.mockResolvedValue({
      ...SUMMARY,
      outbox: { ...SUMMARY.outbox, revokeUnavailable: true },
    });

    const response = await GET(request('Bearer super-secret-cron'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: 'Calendar revoke is unavailable',
      outbox: { revokeUnavailable: true },
    });
    expect(loggerError).toHaveBeenCalledWith(
      '[external-connection-maintenance] revoke key is unavailable',
    );
  });

  it('dispatcher失敗は安全な500とSentry通知に変換する', async () => {
    const error = new Error('v1.secret-ciphertext');
    dispatchExternalConnectionMaintenance.mockRejectedValue(error);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Maintenance dispatch failed' });
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'external_connection_maintenance',
      operation: 'cron_dispatch',
      route: '/api/cron/external-connection-maintenance',
    });
    const captured = captureUnexpectedError.mock.calls[0]?.[0] as Error;
    expect(captured).not.toBe(error);
    expect(captured.message).toBe('External connection maintenance dispatch failed');
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain(error.message);
    expect(loggerError).toHaveBeenCalledWith('[external-connection-maintenance] dispatch failed');
  });

  it('未確認のhard expiryは200のincomplete結果と安全化済み通知にする', async () => {
    dispatchExternalConnectionMaintenance.mockResolvedValue({
      ...SUMMARY,
      outbox: { ...SUMMARY.outbox, expired: 1 },
    });

    const response = await GET(request('Bearer super-secret-cron'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, complete: false, outbox: { expired: 1 } });
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'external_connection_maintenance',
      operation: 'revoke_expired',
      route: '/api/cron/external-connection-maintenance',
    });
    const captured = captureUnexpectedError.mock.calls[0]?.[0] as Error;
    expect(captured.message).toBe('Calendar revoke expired before confirmation');
  });

  it('write fence が有効な時は 503 を返し dispatcher を呼ばない', async () => {
    isWriteFenceEnabled.mockResolvedValue(true);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(503);
    expect(dispatchExternalConnectionMaintenance).not.toHaveBeenCalled();
  });

  it('calendarFinalizeStuck が残る時は complete に関わらず独立した warn を出す（#2055a）', async () => {
    dispatchExternalConnectionMaintenance.mockResolvedValue({
      ...SUMMARY,
      complete: true,
      retention: { ...SUMMARY.retention, hasMore: false },
      calendarFinalizeStuck: 3,
    });

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[external-connection-maintenance] finalize guard candidates are stuck',
      { calendarFinalizeStuck: 3 },
    );
  });
});

describe('external-connection-maintenance heartbeat wiring', () => {
  it('records start and completion only around successful authorized work', async () => {
    await GET(request());
    expect(writeCronHeartbeat).not.toHaveBeenCalled();
    const response = await GET(request('Bearer super-secret-cron'));
    expect(response.status).toBe(200);
    expect(writeCronHeartbeat).toHaveBeenNthCalledWith(
      1,
      'external-connection-maintenance',
      'started',
      expect.any(String),
    );
    expect(writeCronHeartbeat).toHaveBeenNthCalledWith(
      2,
      'external-connection-maintenance',
      'completed',
      writeCronHeartbeat.mock.calls[0]![2],
    );
    expect(writeCronHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchExternalConnectionMaintenance.mock.invocationCallOrder[0]!,
    );
    expect(writeCronHeartbeat.mock.invocationCallOrder[1]).toBeGreaterThan(
      dispatchExternalConnectionMaintenance.mock.invocationCallOrder[0]!,
    );
  });
  it('keeps failed dispatch distinguishable from completion', async () => {
    dispatchExternalConnectionMaintenance.mockRejectedValueOnce(new Error('fixture failure'));
    expect((await GET(request('Bearer super-secret-cron'))).status).toBe(500);
    expect(writeCronHeartbeat).toHaveBeenCalledTimes(1);
    expect(writeCronHeartbeat.mock.calls[0]![1]).toBe('started');
  });
});

it('DBが未対応なら完了heartbeatを更新しない', async () => {
  dispatchExternalConnectionMaintenance.mockResolvedValue({ ...SUMMARY, schemaUnavailable: true });
  const response = await GET(request('Bearer super-secret-cron'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schemaUnavailable: true });
  expect(writeCronHeartbeat.mock.calls.map((call) => call[1])).toEqual(['started']);
});
