import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchCalendarAccountDeletionSettle = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const isWriteFenceEnabled = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () => ({ CRON_SECRET: 'super-secret-cron' }) as { CRON_SECRET?: string | undefined },
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('./_composition/settle-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_composition/settle-dispatcher')>();
  return { ...actual, dispatchCalendarAccountDeletionSettle };
});
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
vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: vi.fn(() => ({})) }));

import {
  CalendarAccountDeletionSettleError,
  SETTLE_WORST_CASE_MS,
} from './_composition/settle-dispatcher';
import { GET, maxDuration, TIME_BUDGET_MS } from './route';

const URL = 'https://app.dayopt.app/api/cron/calendar-account-deletion-settle';

const SUMMARY = {
  normalized: 1,
  inFlight: 0,
  other: 0,
  skipped: false,
  durationMs: 50,
};

function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new NextRequest(URL, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CRON_SECRET = 'super-secret-cron';
  dispatchCalendarAccountDeletionSettle.mockResolvedValue(SUMMARY);
  isWriteFenceEnabled.mockResolvedValue(false);
});

describe('calendar account deletion settle cron', () => {
  // round 2 review で発見した「既存 cron に同居させると予算不等式が破綻する」問題（#2055
  // コメント参照）を踏まえ、この独立 cron 自身の予算不等式を実測で固定する。
  it('cron の時間予算に SETTLE_WORST_CASE_MS を余裕を持って収める', async () => {
    expect(maxDuration).toBe(60);

    const before = Date.now();
    await GET(request('Bearer super-secret-cron'));
    const after = Date.now();

    const passed = dispatchCalendarAccountDeletionSettle.mock.calls[0]?.[0];
    expect(passed?.deadlineAt).toBeGreaterThanOrEqual(before + TIME_BUDGET_MS);
    expect(passed?.deadlineAt).toBeLessThanOrEqual(after + TIME_BUDGET_MS);

    // TIME_BUDGET_MS(50s) が SETTLE_WORST_CASE_MS を上回り、かつ maxDuration(60s) までの
    // hard-kill margin が残ることを固定する。route.ts の実値を import する（pr-cross-review
    // 指摘 — リテラル複製だと route.ts 側の値変更に test が追従しない）。
    const CRON_MAX_DURATION_MS = 60 * 1_000;
    expect(SETTLE_WORST_CASE_MS).toBeLessThanOrEqual(TIME_BUDGET_MS);
    expect(TIME_BUDGET_MS).toBeLessThan(CRON_MAX_DURATION_MS);
  });

  it('CRON_SECRET未設定なら503でdispatcherを呼ばない', async () => {
    envMock.CRON_SECRET = undefined;

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(dispatchCalendarAccountDeletionSettle).not.toHaveBeenCalled();
  });

  it('CRON_SECRETが16文字未満なら503でdispatcherを呼ばない', async () => {
    envMock.CRON_SECRET = 'too-short';

    const response = await GET(request('Bearer too-short'));

    expect(response.status).toBe(503);
    expect(dispatchCalendarAccountDeletionSettle).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Bearer wrong-secret', 'super-secret-cron'])(
    'Bearer認証不一致(%s)は401',
    async (authorization) => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      expect(dispatchCalendarAccountDeletionSettle).not.toHaveBeenCalled();
    },
  );

  it('Bearer 一致で 200 と summary を返し dispatcher を呼ぶ', async () => {
    const response = await GET(request('Bearer super-secret-cron'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, ...SUMMARY });
  });

  it('write fence が有効な時は 503 を返し dispatcher を呼ばない', async () => {
    isWriteFenceEnabled.mockResolvedValue(true);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(503);
    expect(dispatchCalendarAccountDeletionSettle).not.toHaveBeenCalled();
  });

  it('skipped の時は warn を出す', async () => {
    dispatchCalendarAccountDeletionSettle.mockResolvedValue({ ...SUMMARY, skipped: true });

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[calendar-account-deletion-settle] settle was skipped this run',
    );
  });

  it('in_flight / other が残る時は warn を出す', async () => {
    dispatchCalendarAccountDeletionSettle.mockResolvedValue({
      ...SUMMARY,
      inFlight: 2,
      other: 1,
    });

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[calendar-account-deletion-settle] unresolved rows remain',
      { inFlight: 2, other: 1 },
    );
  });

  it('dispatcher失敗は安全な500とSentry通知に変換する（未分類の raw error は context を持たない）', async () => {
    const error = new Error('v1.secret-ciphertext');
    dispatchCalendarAccountDeletionSettle.mockRejectedValue(error);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Settle dispatch failed' });
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'external_calendar',
      operation: 'cron_dispatch',
      route: '/api/cron/calendar-account-deletion-settle',
    });
    const captured = captureUnexpectedError.mock.calls[0]?.[0] as Error;
    expect(captured).not.toBe(error);
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain(error.message);
    expect(loggerError).toHaveBeenCalledWith('[calendar-account-deletion-settle] dispatch failed');
  });

  // DAYOPT-V（#2305）: generic dispatch failure で真因が観測不能だった穴を塞ぐ回帰。
  // dispatcher が CalendarAccountDeletionSettleError で reject した時、原因の code/message
  // が errorCode/errorMessage として captureUnexpectedError の context へ伝搬することを固定する。
  it('CalendarAccountDeletionSettleError は原因の code/message を Sentry context へ伝搬する', async () => {
    const error = new CalendarAccountDeletionSettleError('normalize', {
      code: '55P03',
      message: 'could not obtain lock on row in relation "timeblock_supported_writer_v1"',
    });
    dispatchCalendarAccountDeletionSettle.mockRejectedValue(error);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'external_calendar',
      operation: 'cron_dispatch',
      route: '/api/cron/calendar-account-deletion-settle',
      errorCode: '55P03',
      errorMessage: 'could not obtain lock on row in relation "timeblock_supported_writer_v1"',
    });
    const captured = captureUnexpectedError.mock.calls[0]?.[0] as Error;
    expect(captured).not.toBe(error);
  });

  // causeCode が無い場合（例: client 生成失敗）は stage 自身の code へフォールバックする。
  it('causeCode が無い CalendarAccountDeletionSettleError は自身の stage code を errorCode に使う', async () => {
    const error = new CalendarAccountDeletionSettleError('client', {
      message: 'missing SUPABASE_SECRET_KEY',
    });
    dispatchCalendarAccountDeletionSettle.mockRejectedValue(error);

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'external_calendar',
      operation: 'cron_dispatch',
      route: '/api/cron/calendar-account-deletion-settle',
      errorCode: 'ACCOUNT_DELETION_SETTLE_CLIENT_FAILED',
      errorMessage: 'missing SUPABASE_SECRET_KEY',
    });
  });
});
