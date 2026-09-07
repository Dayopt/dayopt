import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicPlanRow } from '@/lib/database';

import { TimeblockCommandClient } from './timeblock-command-client';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: (error: unknown) =>
    error instanceof Error ? error : new Error('database command failed'),
}));

const plan: PublicPlanRow = {
  created_at: '2026-07-23T00:00:00.000001Z',
  deleted_at: null,
  end_at: '2026-07-24T02:00:00.000000Z',
  external_calendar_event_id: null,
  id: '00000000-0000-4000-8000-000000000001',
  note: null,

  source: 'manual',
  start_at: '2026-07-24T01:00:00.000000Z',
  activity_id: null,
  title: 'Plan',
  updated_at: '2026-07-23T00:00:00.000001Z',
  user_id: '00000000-0000-4000-8000-000000000002',
};

function createPlanInput() {
  return {
    userId: plan.user_id,
    title: plan.title,
    note: plan.note,
    activityId: null,
    externalCalendarEventId: plan.external_calendar_event_id,
    source: 'manual' as const,
    startAt: plan.start_at,
    endAt: plan.end_at,
  };
}

describe('TimeblockCommandClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tenantとnullable fieldを原子的create commandへ閉じ込める', async () => {
    rpc.mockResolvedValue({ data: [plan], error: null });

    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).resolves.toEqual(plan);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('create_plan_command_v1', {
      p_activity_id: null,
      p_end_at: plan.end_at,
      p_external_calendar_event_id: null,
      p_note: null,
      p_source: 'manual',
      p_start_at: plan.start_at,
      p_title: plan.title,
      p_user_id: plan.user_id,
    });
  });

  it('raw microsecond CAS tokenを変換せずupdate commandへ渡す', async () => {
    rpc.mockResolvedValue({ data: [plan], error: null });
    const expectedUpdatedAt = '2026-07-23T00:00:00.123456Z';

    await new TimeblockCommandClient().updatePlan({
      ...createPlanInput(),
      planId: plan.id,
      expectedUpdatedAt,
    });

    expect(rpc).toHaveBeenCalledWith(
      'update_plan_command_v1',
      expect.objectContaining({ p_expected_updated_at: expectedUpdatedAt }),
    );
  });

  it('stale versionと消えたversioned targetを別のstable codeへ変換する', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'DT002', message: 'private version detail' },
    });
    await expect(
      new TimeblockCommandClient().updatePlan({
        ...createPlanInput(),
        planId: plan.id,
        expectedUpdatedAt: plan.updated_at,
      }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });

    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'DT001', message: 'private target detail' },
    });
    await expect(
      new TimeblockCommandClient().deletePlan({
        userId: plan.user_id,
        planId: plan.id,
        expectedUpdatedAt: plan.updated_at,
      }),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
  });

  it('deadlockだけをserver内で一度再試行する', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: '40P01', message: 'deadlock' } })
      .mockResolvedValueOnce({ data: [plan], error: null });

    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).resolves.toEqual(plan);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('deadlock再発、lock待ち、timeoutはclient再送向けにせず分類する', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '40P01', message: 'deadlock' } });
    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).rejects.toMatchObject({
      code: 'RETRYABLE_CONTENTION',
    });
    expect(rpc).toHaveBeenCalledTimes(2);

    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: { code: '55P03', message: 'lock timeout' } });
    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).rejects.toMatchObject({
      code: 'RETRYABLE_CONTENTION',
    });
    expect(rpc).toHaveBeenCalledOnce();

    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });
    expect(rpc).toHaveBeenCalledOnce();
  });

  // 直接 DML を剥がしたので、exclusion / unique violation の公開語彙はこの adapter が
  // 唯一の変換点になった（旧 PlanService / RecordService の handleMutationError の後継）
  it('exclusion constraint違反をTIME_OVERLAPへ変換する', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23P01', message: 'conflicting key value violates exclusion constraint' },
    });

    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).rejects.toMatchObject({
      code: 'TIME_OVERLAP',
    });
  });

  it('一意制約違反は保存競合へ変換する', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    await expect(
      new TimeblockCommandClient().recordPlan({
        userId: plan.user_id,
        planId: plan.id,
        expectedUpdatedAt: plan.updated_at,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(new TimeblockCommandClient().createPlan(createPlanInput())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('未来 Record を拒否する trigger の code を公開用 code へ変換する', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'DT005', message: 'trigger detail' } });

    await expect(
      new TimeblockCommandClient().createRecord({
        ...createPlanInput(),
        planId: plan.id,
        fulfillment: null,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_IN_FUTURE' });
  });
});
