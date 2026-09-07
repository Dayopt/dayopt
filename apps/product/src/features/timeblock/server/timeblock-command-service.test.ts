import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';

import type { TimeblockCommandClient } from './timeblock-command-client';
import { TimeblockCommandService } from './timeblock-command-service';
import type { PlanRow, RecordRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

const trackProductEvent = vi.hoisted(() => vi.fn());
const trackProductEvents = vi.hoisted(() => vi.fn());

vi.mock('@/lib/analytics/product-events', () => ({ trackProductEvent, trackProductEvents }));

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const PLAN_ID = '00000000-0000-4000-8000-0000000000b1';
const RECORD_ID = '00000000-0000-4000-8000-0000000000c1';

const plan: PlanRow = {
  created_at: '2026-07-29T00:00:00.000001Z',
  deleted_at: null,
  end_at: '2026-07-30T02:00:00.000000Z',
  external_calendar_event_id: null,
  id: PLAN_ID,
  note: 'old note',
  skipped_at: null,
  source: 'api',
  start_at: '2026-07-30T01:00:00.000000Z',
  activity_id: null,
  title: 'Original',
  updated_at: '2026-07-29T00:00:00.000001Z',
  user_id: USER_ID,
};

const record: RecordRow = {
  created_at: '2026-07-29T00:00:00.000001Z',
  deleted_at: null,
  end_at: '2026-07-28T02:00:00.000000Z',
  external_calendar_event_id: null,
  fulfillment: null,
  id: RECORD_ID,
  note: null,
  plan_id: PLAN_ID,
  source: 'manual',
  start_at: '2026-07-28T01:00:00.000000Z',
  activity_id: null,
  title: 'Record',
  updated_at: '2026-07-29T00:00:00.000002Z',
  user_id: USER_ID,
};

function createCommands() {
  return {
    createPlan: vi.fn(),
    updatePlan: vi.fn().mockResolvedValue(plan),
    deletePlan: vi.fn(),
    restorePlan: vi.fn(),
    setPlanSkipped: vi.fn(),
    recordPlan: vi.fn(),
    confirmDay: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn().mockResolvedValue(record),
    deleteRecord: vi.fn(),
    restoreRecord: vi.fn(),
  };
}

describe('TimeblockCommandService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackProductEvent.mockResolvedValue(undefined);
    trackProductEvents.mockResolvedValue(undefined);
  });

  it('successful create/record commands emit payload-free events after the command', async () => {
    const supabase = createMockSupabase();
    const commands = createCommands();
    commands.createPlan.mockResolvedValue(plan);
    commands.recordPlan.mockResolvedValue(record);
    commands.createRecord.mockResolvedValue(record);
    commands.confirmDay.mockResolvedValue([record, { ...record, id: `${RECORD_ID}-2` }]);
    const service = new TimeblockCommandService(
      supabase as unknown as ServiceSupabaseClient,
      commands as unknown as TimeblockCommandClient,
    );

    await service.createPlan({
      userId: USER_ID,
      input: {
        title: 'Plan',
        start_at: plan.start_at,
        end_at: plan.end_at,
      },
    });
    await service.recordPlan({
      userId: USER_ID,
      id: PLAN_ID,
      expectedUpdatedAt: plan.updated_at,
    });
    await service.createRecord({
      userId: USER_ID,
      input: {
        title: 'Record',
        start_at: record.start_at,
        end_at: record.end_at,
      },
    });
    await service.confirmDay({
      userId: USER_ID,
      input: { start_at: record.start_at, end_at: record.end_at },
    });

    expect(trackProductEvent).toHaveBeenNthCalledWith(1, {
      eventName: 'plan_created',
      userId: USER_ID,
    });
    expect(trackProductEvent).toHaveBeenNthCalledWith(2, {
      eventName: 'record_created',
      userId: USER_ID,
    });
    expect(trackProductEvent).toHaveBeenNthCalledWith(3, {
      eventName: 'record_created',
      userId: USER_ID,
    });
    expect(trackProductEvents).toHaveBeenCalledWith([
      { eventName: 'record_created', userId: USER_ID },
      { eventName: 'record_created', userId: USER_ID },
    ]);
  });

  it('partial Plan updateをuser内の現在行で補い、raw CAS tokenを保持する', async () => {
    const query = createChainableMock(plan);
    const supabase = createMockSupabase({ from: vi.fn(() => query) });
    const commands = createCommands();
    const expectedUpdatedAt = '2026-07-29T00:00:00.123456Z';
    const service = new TimeblockCommandService(
      supabase as unknown as ServiceSupabaseClient,
      commands as unknown as TimeblockCommandClient,
    );

    await service.updatePlan({
      userId: USER_ID,
      id: PLAN_ID,
      expectedUpdatedAt,
      input: { title: 'Changed' },
    });

    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(commands.updatePlan).toHaveBeenCalledWith({
      userId: USER_ID,
      planId: PLAN_ID,
      expectedUpdatedAt,
      title: 'Changed',
      note: plan.note,
      activityId: plan.activity_id,
      externalCalendarEventId: plan.external_calendar_event_id,
      source: 'api',
      startAt: plan.start_at,
      endAt: plan.end_at,
    });
  });

  it('partial Record updateも別userを参照せず、現在行を補完する', async () => {
    const query = createChainableMock(record);
    const supabase = createMockSupabase({ from: vi.fn(() => query) });
    const commands = createCommands();
    const service = new TimeblockCommandService(
      supabase as unknown as ServiceSupabaseClient,
      commands as unknown as TimeblockCommandClient,
    );

    await service.updateRecord({
      userId: USER_ID,
      id: RECORD_ID,
      expectedUpdatedAt: record.updated_at,
      input: { note: 'changed note' },
    });

    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(commands.updateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        recordId: RECORD_ID,
        expectedUpdatedAt: record.updated_at,
        note: 'changed note',
        planId: PLAN_ID,
      }),
    );
  });
  // service は userId を検証しない。渡された値がそのまま command の p_user_id になり、
  // 直接 DML を剥がした後は RLS も止めない。owner 境界を持っているのは router 側の
  // `.strict()` + 明示 field だけ、という前提をここで固定する（#2627）。
  it('serviceは渡されたuserIdをそのままcommandのownerとして使う', async () => {
    const otherUserId = '00000000-0000-4000-8000-0000000000ff';
    const query = createChainableMock({ ...plan, user_id: otherUserId });
    const supabase = createMockSupabase({ from: vi.fn(() => query) });
    const commands = createCommands();
    const service = new TimeblockCommandService(
      supabase as unknown as ServiceSupabaseClient,
      commands as unknown as TimeblockCommandClient,
    );

    await service.updatePlan({
      userId: otherUserId,
      id: PLAN_ID,
      expectedUpdatedAt: plan.updated_at,
      input: { title: 'Changed' },
    });

    expect(query.eq).toHaveBeenCalledWith('user_id', otherUserId);
    expect(commands.updatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: otherUserId, planId: PLAN_ID }),
    );

    await service.deletePlan({
      userId: otherUserId,
      id: PLAN_ID,
      expectedUpdatedAt: plan.updated_at,
    });

    expect(commands.deletePlan).toHaveBeenCalledWith({
      userId: otherUserId,
      planId: PLAN_ID,
      expectedUpdatedAt: plan.updated_at,
    });
  });
});
