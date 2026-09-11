/**
 * MCP 読み取り経路のテナント分離を実 DB で固定する（#2721 の V-1）。
 *
 * MCP の読み取りは `createMcpTrpcCaller` が **service-role client** で tRPC を呼ぶ
 * （`lib/mcp/trpc-bridge.ts`）。service_role は `rolbypassrls = t` なので RLS は効かず、
 * 「どのユーザーの行か」を決めているのは各 service の `.eq('user_id', ctx.userId)` /
 * `rpc(p_user_id)` **だけ**である。書き込み側には `assert_timeblock_writer_row_v1` の
 * row trigger という二重の網があるが、読み取り側には DB 側の網が無い。
 *
 * したがって新しい read tool をコピペで足した時にフィルタを 1 箇所落とすと、
 * そのままテナント越境になる（REVIEW-1）。この suite はその class を閉じるために、
 * **owner の caller には見え、intruder の caller には見えない**ことを読み取り経路
 * すべてで確認する。
 *
 * 偽グリーン対策（TEST-1）: 各ケースは「owner には見える」を先に assert する。
 * seed が失敗して空集合になっていれば owner 側で落ちるので、「intruder に見えない」
 * だけが無条件に通ることはない。intruder 側にも同じ形のデータを作るので、
 * 「常に空を返す」実装でも通らない。
 *
 * 新しい read tool を足す時は、この suite にも 1 ケース足すこと。
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTimeblockTrashReadClient } from '@/features/timeblock/server/service-index';
import type { Database } from '@/lib/database';
import { createMcpTrpcCaller } from '@/lib/mcp/trpc-bridge';
import type { SupportedScope } from '@/lib/oauth-server';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ownerId = crypto.randomUUID();
const intruderId = crypto.randomUUID();
const dbNull = null as never;

const ALL_READ_SCOPES: SupportedScope[] = [
  'read:entries',
  'read:activities',
  'read:constraints',
  'read:stats',
];

/** 実 MCP と同じ経路（service-role client + mcp_internal marker）で読む。 */
function callerFor(userId: string, scopes: SupportedScope[] = ALL_READ_SCOPES) {
  return createMcpTrpcCaller({ userId, clientId: 'chatgpt', scopes });
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** `getConstraints` / `getMcpReview` は offset 付き ISO と 31 日以内の範囲を要求する。 */
function rangeAround(): { startDate: string; endDate: string } {
  return { startDate: at(-7 * 24 * 60 * 60_000), endDate: at(7 * 24 * 60 * 60_000) };
}

interface TenantFixture {
  categoryId: string;
  activityId: string;
  planId: string;
  recordId: string;
  segmentId: string;
  deletedPlanId: string;
  deletedRecordId: string;
}

async function createUser(id: string): Promise<void> {
  const { error } = await admin.auth.admin.createUser({
    id,
    email: `mcp-read-isolation-${id}@example.com`,
    password: 'test-password-123',
    email_confirm: true,
  });
  if (error) throw error;
}

async function seedTenantData(userId: string, label: string): Promise<TenantFixture> {
  const { data: category, error: categoryError } = await admin
    .from('categories')
    .insert({ user_id: userId, name: `${label} category` })
    .select('id')
    .single();
  if (categoryError) throw categoryError;

  const { data: activity, error: activityError } = await admin
    .from('activities')
    .insert({ user_id: userId, name: `${label} activity`, category_id: category.id })
    .select('id')
    .single();
  if (activityError) throw activityError;

  const { data: plan, error: planError } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: `${label} plan`,
      p_note: dbNull,
      p_activity_id: activity.id,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(2 * 60 * 60_000),
      p_end_at: at(3 * 60 * 60_000),
    })
    .single();
  if (planError) throw planError;

  // Record は過去にしか終われない（DT005）。
  const { data: record, error: recordError } = await admin
    .rpc('create_record_command_v1', {
      p_user_id: userId,
      p_title: `${label} record`,
      p_note: dbNull,
      p_plan_id: dbNull,
      p_activity_id: activity.id,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(-3 * 60 * 60_000),
      p_end_at: at(-2 * 60 * 60_000),
    })
    .single();
  if (recordError) throw recordError;

  const { data: segment, error: segmentError } = await admin
    .from('segments')
    .insert({ user_id: userId, name: `${label} segment` })
    .select('id')
    .single();
  if (segmentError) throw segmentError;

  const { error: membershipError } = await admin
    .from('segment_activities')
    .insert({ user_id: userId, segment_id: segment.id, activity_id: activity.id });
  if (membershipError) throw membershipError;

  return {
    categoryId: category.id,
    activityId: activity.id,
    planId: plan.id,
    recordId: record.id,
    segmentId: segment.id,
    deletedPlanId: await createDeletedPlan(userId, `${label} trashed plan`),
    deletedRecordId: await createDeletedRecord(userId, `${label} trashed record`),
  };
}

async function createDeletedPlan(userId: string, title: string): Promise<string> {
  const { data, error } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: title,
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(5 * 60 * 60_000),
      p_end_at: at(6 * 60 * 60_000),
    })
    .single();
  if (error) throw error;

  const { error: deleteError } = await admin.rpc('delete_plan_command_v1', {
    p_user_id: userId,
    p_plan_id: data.id,
    p_expected_updated_at: data.updated_at,
  });
  if (deleteError) throw deleteError;
  return data.id;
}

async function createDeletedRecord(userId: string, title: string): Promise<string> {
  const { data, error } = await admin
    .rpc('create_record_command_v1', {
      p_user_id: userId,
      p_title: title,
      p_note: dbNull,
      p_plan_id: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(-6 * 60 * 60_000),
      p_end_at: at(-5 * 60 * 60_000),
    })
    .single();
  if (error) throw error;

  const { error: deleteError } = await admin.rpc('delete_record_command_v1', {
    p_user_id: userId,
    p_record_id: data.id,
    p_expected_updated_at: data.updated_at,
  });
  if (deleteError) throw deleteError;
  return data.id;
}

let owner: TenantFixture;
let intruder: TenantFixture;

describe.skipIf(!RUN_LOCAL)('MCP read tenant isolation', () => {
  beforeAll(async () => {
    await createUser(ownerId);
    await createUser(intruderId);
    owner = await seedTenantData(ownerId, 'owner');
    intruder = await seedTenantData(intruderId, 'intruder');
  }, 60_000);

  afterAll(async () => {
    await admin.auth.admin.deleteUser(intruderId);
    await admin.auth.admin.deleteUser(ownerId);
  });

  it('keeps plans and records in the caller lane for list reads', async () => {
    const ownerPlans = await callerFor(ownerId).plans.list({ limit: 100 });
    const ownerRecords = await callerFor(ownerId).records.list({ limit: 100 });
    expect(ownerPlans.map((plan) => plan.id)).toContain(owner.planId);
    expect(ownerRecords.map((record) => record.id)).toContain(owner.recordId);

    const intruderPlans = await callerFor(intruderId).plans.list({ limit: 100 });
    const intruderRecords = await callerFor(intruderId).records.list({ limit: 100 });
    expect(intruderPlans.map((plan) => plan.id)).toContain(intruder.planId);
    expect(intruderPlans.map((plan) => plan.id)).not.toContain(owner.planId);
    expect(intruderRecords.map((record) => record.id)).toContain(intruder.recordId);
    expect(intruderRecords.map((record) => record.id)).not.toContain(owner.recordId);
  });

  it('hides foreign identity from detail reads instead of leaking it', async () => {
    await expect(callerFor(ownerId).plans.getById({ id: owner.planId })).resolves.toMatchObject({
      id: owner.planId,
    });
    await expect(callerFor(ownerId).records.getById({ id: owner.recordId })).resolves.toMatchObject(
      { id: owner.recordId },
    );

    // 他人の id を直に指定しても、存在有無を区別できる情報を返さない。
    await expect(callerFor(intruderId).plans.getById({ id: owner.planId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      callerFor(intruderId).records.getById({ id: owner.recordId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps activities, categories and segments in the caller lane', async () => {
    const ownerActivities = await callerFor(ownerId).activities.listActivities({});
    const ownerCategories = await callerFor(ownerId).activities.listCategories({});
    const ownerSegments = await callerFor(ownerId).review.listSegments();
    expect(ownerActivities.map((activity) => activity.id)).toContain(owner.activityId);
    expect(ownerCategories.map((category) => category.id)).toContain(owner.categoryId);
    expect(ownerSegments.map((segment) => segment.id)).toContain(owner.segmentId);

    const intruderActivities = await callerFor(intruderId).activities.listActivities({});
    const intruderCategories = await callerFor(intruderId).activities.listCategories({});
    const intruderSegments = await callerFor(intruderId).review.listSegments();
    expect(intruderActivities.map((activity) => activity.id)).toContain(intruder.activityId);
    expect(intruderActivities.map((activity) => activity.id)).not.toContain(owner.activityId);
    expect(intruderCategories.map((category) => category.id)).toContain(intruder.categoryId);
    expect(intruderCategories.map((category) => category.id)).not.toContain(owner.categoryId);
    expect(intruderSegments.map((segment) => segment.id)).toContain(intruder.segmentId);
    expect(intruderSegments.map((segment) => segment.id)).not.toContain(owner.segmentId);
    // セグメントのメンバーシップ経由で他人の activity id が漏れないことも見る。
    expect(intruderSegments.flatMap((segment) => segment.activityIds)).not.toContain(
      owner.activityId,
    );
  });

  it('keeps aggregate reads from summing another tenant', async () => {
    const range = rangeAround();

    // 占有区間は id を返さないので件数で見る。両テナントに同じ形のデータがあるので、
    // 他人の分を足していれば intruder 側だけが増える。
    const ownerConstraints = await callerFor(ownerId).timeblockContext.getConstraints(range);
    const intruderConstraints = await callerFor(intruderId).timeblockContext.getConstraints(range);
    const ownerOccupancy =
      ownerConstraints.occupancy.plans.length + ownerConstraints.occupancy.records.length;
    const intruderOccupancy =
      intruderConstraints.occupancy.plans.length + intruderConstraints.occupancy.records.length;
    expect(ownerOccupancy).toBeGreaterThan(0);
    expect(intruderOccupancy).toBe(ownerOccupancy);

    const ownerReview = await callerFor(ownerId).statistics.getMcpReview(range);
    const intruderReview = await callerFor(intruderId).statistics.getMcpReview(range);
    expect(ownerReview.summary.recordedMinutes).toBeGreaterThan(0);
    expect(intruderReview.summary.recordedMinutes).toBe(ownerReview.summary.recordedMinutes);
    // アクティビティ別の内訳にも他人の activity が現れないこと。
    expect(intruderReview.activities.map((row) => row.activityId)).not.toContain(owner.activityId);
  });

  it('keeps the trash lanes separated even though they bypass tRPC', async () => {
    // `plans.trash.list` / `records.trash.list` は tRPC を経由せず service-role client を
    // 直に使う（`mcp-timeblock-read-client.ts`）。分離は `.eq('user_id')` の 1 箇所だけ。
    const trash = createTimeblockTrashReadClient();

    const ownerTrashedPlans = await trash.listDeletedPlans(ownerId, 100);
    const ownerTrashedRecords = await trash.listDeletedRecords(ownerId, 100);
    expect(ownerTrashedPlans.map((plan) => plan.id)).toContain(owner.deletedPlanId);
    expect(ownerTrashedRecords.map((record) => record.id)).toContain(owner.deletedRecordId);

    const intruderTrashedPlans = await trash.listDeletedPlans(intruderId, 100);
    const intruderTrashedRecords = await trash.listDeletedRecords(intruderId, 100);
    expect(intruderTrashedPlans.map((plan) => plan.id)).toContain(intruder.deletedPlanId);
    expect(intruderTrashedPlans.map((plan) => plan.id)).not.toContain(owner.deletedPlanId);
    expect(intruderTrashedRecords.map((record) => record.id)).toContain(intruder.deletedRecordId);
    expect(intruderTrashedRecords.map((record) => record.id)).not.toContain(owner.deletedRecordId);
  });

  it('denies procedures outside the granted scope', async () => {
    // route 級の preflight（`app/api/mcp/route.ts`）とは別に、procedure 級の allowlist が
    // 既定拒否で効いていること（`lib/trpc/procedures.ts` の MCP_TRPC_SCOPE_REQUIREMENTS）。
    const entriesOnly = callerFor(ownerId, ['read:entries']);

    await expect(entriesOnly.plans.list({ limit: 10 })).resolves.toBeDefined();
    await expect(entriesOnly.activities.listActivities({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(entriesOnly.review.listSegments()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(entriesOnly.timeblockContext.getConstraints(rangeAround())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(entriesOnly.statistics.getMcpReview(rangeAround())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
