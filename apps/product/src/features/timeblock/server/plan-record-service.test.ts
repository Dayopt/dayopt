import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publicRecordSelect } from '@/lib/database';
import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';
import { PlanService } from './plan-service';
import { RecordService } from './record-service';
import { TimeblockServiceError } from './timeblock-service-error';
import type { PlanRow, RecordRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

const USER_ID = 'test-user-id';
const ACTIVITY_ID = '9f1d7c3e-5b2a-4d18-9c64-8a3f0e1b7d55';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * #1893 で legacy route と、それを支えていた write method を削除したため、
 * PlanService / RecordService は read 専用になった。write 側の境界 test は
 * timeblock-command-service.test.ts / timeblock-command-router.test.ts が持つ。
 */
function createPlanService(mockSupabase = createMockSupabase()) {
  return {
    mockSupabase,
    service: new PlanService(mockSupabase as unknown as ServiceSupabaseClient),
  };
}

function createRecordService(mockSupabase = createMockSupabase()) {
  return {
    mockSupabase,
    service: new RecordService(mockSupabase as unknown as ServiceSupabaseClient),
  };
}

function createPlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    deleted_at: null,
    end_at: '2030-03-17T11:00:00.000Z',
    external_calendar_event_id: null,
    id: 'plan-1',
    note: null,
    skipped_at: null,
    source: 'manual',
    start_at: '2030-03-17T10:00:00.000Z',
    activity_id: null,
    title: 'Plan',
    updated_at: '2026-07-01T00:00:00.000Z',
    user_id: USER_ID,
    ...overrides,
  };
}

function createRecord(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    deleted_at: null,
    end_at: '2026-03-17T11:00:00.000Z',
    external_calendar_event_id: null,
    fulfillment: null,
    id: 'record-1',
    note: null,
    plan_id: null,
    source: 'manual',
    start_at: '2026-03-17T10:00:00.000Z',
    activity_id: null,
    title: 'Record',
    updated_at: '2026-07-01T00:00:00.000Z',
    user_id: USER_ID,
    ...overrides,
  };
}

describe('PlanService.list', () => {
  it('同一userの現役アクティビティ名をnoteと同じOR条件で検索する', async () => {
    const plan = createPlan({ activity_id: ACTIVITY_ID, title: 'Legacy plan title' });
    const planQuery = createChainableMock([plan]);
    const activityQuery = createChainableMock([{ id: ACTIVITY_ID }]);
    const { service, mockSupabase } = createPlanService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : planQuery,
    );

    await expect(
      service.list({ userId: USER_ID, search: 'Focus', sortOrder: 'desc', limit: 21 }),
    ).resolves.toEqual([plan]);

    expect(activityQuery.select).toHaveBeenCalledWith('id');
    expect(activityQuery.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(activityQuery.is).toHaveBeenCalledWith('archived_at', null);
    expect(activityQuery.ilike).toHaveBeenCalledWith('name', '%Focus%');
    expect(planQuery.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(planQuery.is).toHaveBeenCalledWith('deleted_at', null);
    expect(planQuery.is).not.toHaveBeenCalledWith('skipped_at', null);
    // Step 8（tag_id 剥離）で tags 名前検索を除去したため、activity_id のみの和集合になる
    expect(planQuery.or).toHaveBeenCalledWith(`note.ilike.%Focus%,activity_id.in.(${ACTIVITY_ID})`);
    expect(planQuery.or).not.toHaveBeenCalledWith(expect.stringContaining('title.ilike'));
    expect(planQuery.order).toHaveBeenCalledWith('start_at', { ascending: false });
    expect(planQuery.limit).toHaveBeenCalledWith(21);
  });

  it('分類検索失敗時は不完全なplan一覧を返さない', async () => {
    const planQuery = createChainableMock([createPlan()]);
    const activityQuery = createChainableMock([], { message: 'activity lookup failed' });
    const { service, mockSupabase } = createPlanService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : planQuery,
    );

    await expect(service.list({ userId: USER_ID, search: 'Focus' })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: 'Failed to search timeblock classifications',
    });

    expect(planQuery.or).not.toHaveBeenCalled();
  });

  it('検索query失敗時はDB messageを例外へ含めない', async () => {
    const privateError = 'parse failed near note.ilike.%private words%';
    const recordQuery = createChainableMock([], { message: privateError });
    const activityQuery = createChainableMock([]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : recordQuery,
    );

    const caught = await service
      .list({ userId: USER_ID, search: 'private words' })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TimeblockServiceError);
    if (!(caught instanceof TimeblockServiceError)) throw caught;
    expect(caught).toMatchObject({ code: 'FETCH_FAILED', message: 'Failed to fetch records' });
    expect(caught.message).not.toContain(privateError);
  });

  it('user scopeを維持して指定したidに絞り込む', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const query = createChainableMock([]);
    const { service, mockSupabase } = createPlanService();
    mockSupabase.from.mockReturnValue(query);

    await expect(service.list({ userId: USER_ID, ids })).resolves.toEqual([]);

    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(query.in).toHaveBeenCalledWith('id', ids);
  });

  it('idsが空配列ならDBへ問い合わせず空配列を返す', async () => {
    const { service, mockSupabase } = createPlanService();

    await expect(service.list({ userId: USER_ID, ids: [] })).resolves.toEqual([]);

    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe('RecordService.list', () => {
  it('特殊文字を除去してnoteとアクティビティ名を検索する', async () => {
    const record = createRecord({ note: 'Deep work', title: 'Legacy title' });
    const recordQuery = createChainableMock([record]);
    const activityQuery = createChainableMock([]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : recordQuery,
    );

    await expect(
      service.list({
        userId: USER_ID,
        search: ' deep.,()\\%*:_work ',
        sortOrder: 'desc',
        limit: 21,
      }),
    ).resolves.toEqual([record]);

    expect(activityQuery.ilike).toHaveBeenCalledWith('name', '%deepwork%');
    expect(recordQuery.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(recordQuery.select).toHaveBeenCalledWith(publicRecordSelect);
    expect(recordQuery.is).toHaveBeenCalledWith('deleted_at', null);
    expect(recordQuery.or).toHaveBeenCalledWith('note.ilike.%deepwork%');
    expect(recordQuery.or).not.toHaveBeenCalledWith(expect.stringContaining('title.ilike'));
    expect(recordQuery.order).toHaveBeenCalledWith('start_at', { ascending: false });
    expect(recordQuery.limit).toHaveBeenCalledWith(21);
  });

  it('記号だけの検索を無条件一覧へフォールバックさせない', async () => {
    const recordQuery = createChainableMock([]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockReturnValue(recordQuery);

    await expect(service.list({ userId: USER_ID, search: '.,()\\%*:_ ' })).resolves.toEqual([]);

    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    expect(recordQuery.or).toHaveBeenCalledWith('id.is.null');
  });

  it('non-empty一覧にfulfillment_scoreを含めない', async () => {
    const record = createRecord();
    const query = createChainableMock([record]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockReturnValue(query);

    const result = await service.list({ userId: USER_ID });

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('fulfillment_score');
  });

  it('アクティビティ名一致をrecordのOR条件へ加える', async () => {
    const record = createRecord({ activity_id: ACTIVITY_ID });
    const recordQuery = createChainableMock([record]);
    const activityQuery = createChainableMock([{ id: ACTIVITY_ID }]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : recordQuery,
    );

    await expect(service.list({ userId: USER_ID, search: 'Research' })).resolves.toEqual([record]);

    expect(recordQuery.or).toHaveBeenCalledWith(
      `note.ilike.%Research%,activity_id.in.(${ACTIVITY_ID})`,
    );
  });

  it('tag名一致では検索しない（Step 8 で tags 名前検索を除去、唯一のユーザー可視劣化）', async () => {
    // note/title/activity のいずれも 'Research' に一致しない、tag 名だけが一致する旧ブロック。
    // tags 名前検索を除去したため、DB へ渡す filter は note.ilike のみになる
    // （overview.md §Step 8（tag_id 剥離）の設計 の表を参照）。
    const recordQuery = createChainableMock([]);
    const activityQuery = createChainableMock([]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockImplementation((table: string) =>
      table === 'activities' ? activityQuery : recordQuery,
    );

    await expect(service.list({ userId: USER_ID, search: 'Research' })).resolves.toEqual([]);

    expect(recordQuery.or).toHaveBeenCalledWith('note.ilike.%Research%');
  });

  it('user scopeを維持して指定したplan_idに絞り込む', async () => {
    const planIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const query = createChainableMock([]);
    const { service, mockSupabase } = createRecordService();
    mockSupabase.from.mockReturnValue(query);

    await expect(service.list({ userId: USER_ID, planIds })).resolves.toEqual([]);

    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(query.in).toHaveBeenCalledWith('plan_id', planIds);
  });

  it('planIdsが空配列ならDBへ問い合わせず空配列を返す', async () => {
    const { service, mockSupabase } = createRecordService();

    await expect(service.list({ userId: USER_ID, planIds: [] })).resolves.toEqual([]);

    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
