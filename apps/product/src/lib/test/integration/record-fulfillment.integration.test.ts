// #2317: Record 専用の充実度 3 択を実 DB に対して凍結する。
//
// 対象は 20260823223140_add_record_fulfillment.sql が追加した command RPC の
// p_fulfillment / p_fulfillment_present 三状態パターンと、records.fulfillment の
// CHECK 制約。これらは他 integration test（mock 経由の TS 層テスト）では検証できない。

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ownerId = crypto.randomUUID();
const dbNull = null as never;

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function createUser(id: string): Promise<void> {
  const { error } = await admin.auth.admin.createUser({
    id,
    email: `record-fulfillment-${id}@example.com`,
    password: 'test-password-123',
    email_confirm: true,
  });
  if (error) throw error;
}

function recordArgs(overrides: { fulfillment?: string | null } = {}) {
  return {
    p_user_id: ownerId,
    p_title: 'fulfillment probe',
    p_note: dbNull,
    p_plan_id: dbNull,
    p_external_calendar_event_id: dbNull,
    p_source: 'manual',
    p_start_at: at(-2 * 60 * 60_000),
    p_end_at: at(-60 * 60_000),
    ...(overrides.fulfillment !== undefined
      ? { p_fulfillment: overrides.fulfillment as never }
      : {}),
  };
}

describe.skipIf(!RUN_LOCAL)('records.fulfillment command boundary (DB boundary)', () => {
  beforeAll(async () => {
    await createUser(ownerId);
  });

  afterEach(async () => {
    await admin.from('records').delete().eq('user_id', ownerId);
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(ownerId);
  });

  it('p_fulfillment を渡した create は行へそのまま保存する', async () => {
    const { data, error } = await admin
      .rpc('create_record_command_v1', recordArgs({ fulfillment: 'high' }))
      .single();

    expect(error).toBeNull();
    expect(data?.fulfillment).toBe('high');
  });

  it('p_fulfillment 省略の create は未入力（null）のまま作成する', async () => {
    const { data, error } = await admin.rpc('create_record_command_v1', recordArgs()).single();

    expect(error).toBeNull();
    expect(data?.fulfillment).toBeNull();
  });

  it('無効な fulfillment 値を渡す create を DT012 で拒否する', async () => {
    const { error } = await admin
      .rpc('create_record_command_v1', recordArgs({ fulfillment: 'invalid' }))
      .single();

    expect(error?.code).toBe('DT012');
  });

  it('p_fulfillment_present=false（省略）の update は既存値へ触れない', async () => {
    const { data: record } = await admin
      .rpc('create_record_command_v1', recordArgs({ fulfillment: 'low' }))
      .single();

    const { data: updated, error } = await admin
      .rpc('update_record_command_v1', {
        p_user_id: ownerId,
        p_record_id: record!.id,
        p_expected_updated_at: record!.updated_at,
        p_title: 'retitled without touching fulfillment',
        p_note: dbNull,
        p_plan_id: dbNull,
        p_external_calendar_event_id: dbNull,
        p_start_at: record!.start_at,
        p_end_at: record!.end_at,
      })
      .single();

    expect(error).toBeNull();
    expect(updated?.fulfillment).toBe('low');
  });

  it('p_fulfillment_present=true, p_fulfillment=null の update は未入力へ解除する', async () => {
    const { data: record } = await admin
      .rpc('create_record_command_v1', recordArgs({ fulfillment: 'medium' }))
      .single();

    const { data: updated, error } = await admin
      .rpc('update_record_command_v1', {
        p_user_id: ownerId,
        p_record_id: record!.id,
        p_expected_updated_at: record!.updated_at,
        p_title: record!.title,
        p_note: dbNull,
        p_plan_id: dbNull,
        p_external_calendar_event_id: dbNull,
        p_start_at: record!.start_at,
        p_end_at: record!.end_at,
        p_fulfillment: dbNull,
        p_fulfillment_present: true,
      })
      .single();

    expect(error).toBeNull();
    expect(updated?.fulfillment).toBeNull();
  });

  it('p_fulfillment_present=true で新しい値へ更新できる', async () => {
    const { data: record } = await admin
      .rpc('create_record_command_v1', recordArgs({ fulfillment: 'low' }))
      .single();

    const { data: updated, error } = await admin
      .rpc('update_record_command_v1', {
        p_user_id: ownerId,
        p_record_id: record!.id,
        p_expected_updated_at: record!.updated_at,
        p_title: record!.title,
        p_note: dbNull,
        p_plan_id: dbNull,
        p_external_calendar_event_id: dbNull,
        p_start_at: record!.start_at,
        p_end_at: record!.end_at,
        p_fulfillment: 'high' as never,
        p_fulfillment_present: true,
      })
      .single();

    expect(error).toBeNull();
    expect(updated?.fulfillment).toBe('high');
  });

  it('直接 INSERT でも無効な fulfillment 値は CHECK 制約で拒否する（RPC guard を迂回しても防御が効く）', async () => {
    const { error } = await admin.from('records').insert({
      user_id: ownerId,
      title: 'direct insert probe',
      start_at: at(-2 * 60 * 60_000),
      end_at: at(-60 * 60_000),
      source: 'manual',
      fulfillment: 'invalid' as never,
    });

    expect(error?.code).toBe('23514');
  });
});
