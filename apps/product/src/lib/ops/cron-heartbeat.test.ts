import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureUnexpectedError = vi.hoisted(() => vi.fn());
const abortSignal = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: () => ({ from }) }));

import { writeCronHeartbeat } from './cron-heartbeat';

const query = { upsert: vi.fn(), update: vi.fn(), eq: vi.fn(), abortSignal };
beforeEach(() => {
  vi.clearAllMocks();
  from.mockReturnValue(query);
  query.upsert.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  abortSignal.mockResolvedValue({ error: null });
});

describe('cron heartbeat persistence', () => {
  it('preserves prior completion at start and does not overwrite a newer run at completion', async () => {
    const startedAt = new Date().toISOString();
    await writeCronHeartbeat('calendar-sync', 'started', startedAt);
    expect(query.upsert).toHaveBeenCalledWith({
      job_name: 'calendar-sync',
      last_started_at: startedAt,
    });
    await writeCronHeartbeat('calendar-sync', 'completed', startedAt);
    expect(query.eq.mock.calls).toEqual([
      ['job_name', 'calendar-sync'],
      ['last_started_at', startedAt],
    ]);
    expect(query.update).toHaveBeenCalledWith({
      last_completed_at: expect.any(String),
      last_summary: { succeeded: true, duration_ms: expect.any(Number) },
    });
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it('reports sanitized failure without blocking the scheduled work', async () => {
    abortSignal.mockRejectedValue(new Error('private provider value'));
    await expect(
      writeCronHeartbeat('calendar-sync', 'started', new Date().toISOString()),
    ).resolves.toBeUndefined();
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      new Error('Cron heartbeat persistence failed'),
      expect.objectContaining({ route: '/api/cron/calendar-sync' }),
    );
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain(
      'private provider value',
    );
  });
});
