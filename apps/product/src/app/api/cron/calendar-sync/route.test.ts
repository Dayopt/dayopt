import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchCalendarSync = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const writeCronHeartbeat = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const isWriteFenceEnabled = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () => ({ CRON_SECRET: 'super-secret-cron' }) as { CRON_SECRET?: string | undefined },
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/features/external-calendar/server/sync-dispatcher', () => ({ dispatchCalendarSync }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/ops/cron-heartbeat', () => ({ writeCronHeartbeat }));
vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: vi.fn(() => ({})) }));

import { GET } from './route';

const URL = 'https://app.dayopt.app/api/cron/calendar-sync';

function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new NextRequest(URL, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CRON_SECRET = 'super-secret-cron';
  dispatchCalendarSync.mockResolvedValue({ due: 2, processed: 2, skippedNonPro: 0, deferred: 0 });
  isWriteFenceEnabled.mockResolvedValue(false);
});

describe('calendar-sync cron route', () => {
  it('CRON_SECRET 未設定なら 503 で dispatcher を呼ばない', async () => {
    envMock.CRON_SECRET = undefined;

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(503);
    expect(dispatchCalendarSync).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダが無ければ 401', async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(dispatchCalendarSync).not.toHaveBeenCalled();
  });

  it('Bearer が一致しなければ 401', async () => {
    const response = await GET(request('Bearer wrong'));

    expect(response.status).toBe(401);
    expect(dispatchCalendarSync).not.toHaveBeenCalled();
  });

  it('Bearer 一致で 200 と summary を返し dispatcher を呼ぶ', async () => {
    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, processed: 2 });
    expect(dispatchCalendarSync).toHaveBeenCalledTimes(1);
    const arg = dispatchCalendarSync.mock.calls[0]?.[0];
    expect(arg.now).toBeInstanceOf(Date);
    expect(typeof arg.deadlineAt).toBe('number');
  });

  it('dispatcher が投げたら 500 で Sentry に送る', async () => {
    dispatchCalendarSync.mockRejectedValue(new Error('db down'));

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).toHaveBeenCalled();
  });

  it('write fence が有効な時は 503 を返し dispatcher を呼ばない', async () => {
    isWriteFenceEnabled.mockResolvedValue(true);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(503);
    expect(dispatchCalendarSync).not.toHaveBeenCalled();
  });
});

describe('calendar-sync heartbeat wiring', () => {
  it('records start and completion only around successful authorized work', async () => {
    await GET(request());
    expect(writeCronHeartbeat).not.toHaveBeenCalled();
    const response = await GET(request('Bearer super-secret-cron'));
    expect(response.status).toBe(200);
    expect(writeCronHeartbeat).toHaveBeenNthCalledWith(
      1,
      'calendar-sync',
      'started',
      expect.any(String),
    );
    expect(writeCronHeartbeat).toHaveBeenNthCalledWith(
      2,
      'calendar-sync',
      'completed',
      writeCronHeartbeat.mock.calls[0]![2],
    );
    expect(writeCronHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchCalendarSync.mock.invocationCallOrder[0]!,
    );
    expect(writeCronHeartbeat.mock.invocationCallOrder[1]).toBeGreaterThan(
      dispatchCalendarSync.mock.invocationCallOrder[0]!,
    );
  });
  it('keeps failed dispatch distinguishable from completion', async () => {
    dispatchCalendarSync.mockRejectedValueOnce(new Error('fixture failure'));
    expect((await GET(request('Bearer super-secret-cron'))).status).toBe(500);
    expect(writeCronHeartbeat).toHaveBeenCalledTimes(1);
    expect(writeCronHeartbeat.mock.calls[0]![1]).toBe('started');
  });
});
