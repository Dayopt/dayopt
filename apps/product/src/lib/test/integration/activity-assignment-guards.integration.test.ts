// レーン H1。activity 参照の防御層と配線を実 DB に対して固定する。
//
// 元は tag 版（activity-assignment-guards）と対にして両方残す設計だった（「同じ不変条件が
// activity 側でも成立する」ことで移植の正しさを示すため）。tag 版は Step 8（tag_id
// 剥離、issue #2352）で対象の assert_active_timeblock_tag_v1 呼び出しと
// enforce_{plan,record}_tag_owner トリガーごと削除されたため、tag 版ファイルも
// 合わせて削除した。この activity 版だけが残る。
//
// ★ この suite の中心は「保存行を検査する」こと。
//   wrapper -> private の呼び出しは位置引数なので、wrapper のシグネチャにだけ引数を
//   足して private への受け渡しを直し忘れると、DEFAULT が黙って NULL を埋める。
//   その状態でも RPC は成功するため、「呼び出しが成功したこと」を assert する test は
//   配線漏れを緑で通してしまう。必ず保存された行の activity_id を読んで確かめる。

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
const foreignId = crypto.randomUUID();
const dbNull = null as never;

type PlanRow = Database['public']['Tables']['plans']['Row'];

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function createUser(id: string): Promise<void> {
  const { error } = await admin.auth.admin.createUser({
    id,
    email: `activity-guards-${id}@example.com`,
    password: 'test-password-123',
    email_confirm: true,
  });
  if (error) throw error;
}

async function insertActivity(input: {
  userId: string;
  name: string;
  archived?: boolean;
}): Promise<{ id: string }> {
  const { data, error } = await admin
    .from('activities')
    .insert({
      user_id: input.userId,
      name: input.name,
      archived_at: input.archived ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function createPlan(activityId: string | null, offsetHours = 1): Promise<PlanRow> {
  const { data, error } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: ownerId,
      p_title: 'activity guard probe',
      p_note: dbNull,
      p_activity_id: activityId as never,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(offsetHours * 60 * 60_000),
      p_end_at: at((offsetHours + 1) * 60 * 60_000),
    })
    .single();
  if (error) throw error;
  return data;
}

/** 保存された行を DB から読み直す。戻り値ではなく永続化された事実を見る。 */
async function readStoredActivityId(planId: string): Promise<string | null> {
  const { data, error } = await admin.from('plans').select('activity_id').eq('id', planId).single();
  if (error) throw error;
  return data.activity_id;
}

describe.skipIf(!RUN_LOCAL)('activity assignment guards and wiring (DB boundary)', () => {
  beforeAll(async () => {
    await createUser(ownerId);
    await createUser(foreignId);
  });

  afterEach(async () => {
    for (const id of [ownerId, foreignId]) {
      await admin.from('records').delete().eq('user_id', id);
      await admin.from('plans').delete().eq('user_id', id);
      await admin.from('activities').delete().eq('user_id', id);
    }
  });

  afterAll(async () => {
    for (const id of [ownerId, foreignId]) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  // --- 配線: 値が保存行まで到達するか（変種 X を緑で通さないための中心的な test）---

  it('create で渡した activity_id が保存行に到達する', async () => {
    const activity = await insertActivity({ userId: ownerId, name: '開発' });

    const plan = await createPlan(activity.id);

    // 戻り値ではなく保存行を読む。wrapper -> private の配線漏れは戻り値も NULL に
    // なるが、「成功したこと」だけを見る test では検出できない。
    expect(await readStoredActivityId(plan.id)).toBe(activity.id);
  });

  it('Plan -> Record 変換で activity_id がコピーされる', async () => {
    // コピーの実体は public wrapper ではなく private.record_plan_unserialized_v1。
    // wrapper 側だけ直しても 1 行もコピーされないため、保存行で確かめる。
    const activity = await insertActivity({ userId: ownerId, name: '開発' });
    // Record 化は Plan が終了してからしかできない（未来の Plan を記録すると
    // 未来の Record ができてしまい DT005 で弾かれる）。
    // 既存 integration test と同じく、短い Plan を作って終了を待つ。
    const { data: plan, error: createError } = await admin
      .rpc('create_plan_command_v1', {
        p_user_id: ownerId,
        p_title: 'plan to record',
        p_note: dbNull,
        p_activity_id: activity.id as never,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(500),
        p_end_at: at(1_500),
      })
      .single();
    if (createError) throw createError;
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const { data: record, error } = await admin
      .rpc('record_plan_command_v1', {
        p_user_id: ownerId,
        p_plan_id: plan!.id,
        p_expected_updated_at: plan!.updated_at,
      })
      .single();

    expect(error).toBeNull();
    const { data: stored } = await admin
      .from('records')
      .select('activity_id')
      .eq('id', record!.id)
      .single();
    expect(stored?.activity_id).toBe(activity.id);
  });

  // --- 三状態: 旧バンドル保護（指揮台の承認条件）---

  it('旧シグネチャ相当の更新（新引数を両方省略）は activity_id を保持する', async () => {
    // deploy 間隙で旧バンドルが更新を投げる経路。activity_id の存在を知らないので
    // 既存値を渡せず、present が既定 false になる。ここで消えると付与済みの分類が
    // 静かに失われる。
    const activity = await insertActivity({ userId: ownerId, name: '開発' });
    const plan = await createPlan(activity.id);

    const { error } = await admin
      .rpc('update_plan_command_v1', {
        p_user_id: ownerId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_title: 'retitled by an old bundle',
        p_note: dbNull,
        p_external_calendar_event_id: dbNull,
        p_start_at: plan.start_at,
        p_end_at: plan.end_at,
        // p_activity_id / p_activity_id_present は渡さない
      })
      .single();

    expect(error).toBeNull();
    expect(await readStoredActivityId(plan.id)).toBe(activity.id);
  });

  it('present=true は activity_id を上書きする', async () => {
    const before = await insertActivity({ userId: ownerId, name: '開発' });
    const after = await insertActivity({ userId: ownerId, name: '設計' });
    const plan = await createPlan(before.id);

    const { error } = await admin
      .rpc('update_plan_command_v1', {
        p_user_id: ownerId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_title: plan.title,
        p_note: dbNull,
        p_activity_id: after.id as never,
        p_activity_id_present: true,
        p_external_calendar_event_id: dbNull,
        p_start_at: plan.start_at,
        p_end_at: plan.end_at,
      })
      .single();

    expect(error).toBeNull();
    expect(await readStoredActivityId(plan.id)).toBe(after.id);
  });

  it('present=true かつ NULL は activity_id を解除する', async () => {
    const activity = await insertActivity({ userId: ownerId, name: '開発' });
    const plan = await createPlan(activity.id);

    const { error } = await admin
      .rpc('update_plan_command_v1', {
        p_user_id: ownerId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_title: plan.title,
        p_note: dbNull,
        p_activity_id: dbNull,
        p_activity_id_present: true,
        p_external_calendar_event_id: dbNull,
        p_start_at: plan.start_at,
        p_end_at: plan.end_at,
      })
      .single();

    expect(error).toBeNull();
    expect(await readStoredActivityId(plan.id)).toBeNull();
  });

  // --- assert_active_timeblock_activity_v1 ---

  it('アーカイブ済み activity を指す作成を DT014 で拒否する', async () => {
    const archived = await insertActivity({ userId: ownerId, name: '旧', archived: true });

    const { error } = await admin
      .rpc('create_plan_command_v1', {
        p_user_id: ownerId,
        p_title: 'archived probe',
        p_note: dbNull,
        p_activity_id: archived.id as never,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(60 * 60_000),
        p_end_at: at(2 * 60 * 60_000),
      })
      .single();

    expect(error?.code).toBe('DT014');
  });

  it('他ユーザーの activity を指す作成を DT001 で拒否する', async () => {
    const foreign = await insertActivity({ userId: foreignId, name: '他人' });

    const { error } = await admin
      .rpc('create_plan_command_v1', {
        p_user_id: ownerId,
        p_title: 'foreign probe',
        p_note: dbNull,
        p_activity_id: foreign.id as never,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(60 * 60_000),
        p_end_at: at(2 * 60 * 60_000),
      })
      .single();

    expect(error?.code).toBe('DT001');
  });

  it('activity 未指定（NULL）は検証を素通りする', async () => {
    const plan = await createPlan(null);
    expect(await readStoredActivityId(plan.id)).toBeNull();
  });

  it('付与済み activity が後からアーカイブされても、変更しない更新は通る', async () => {
    // tag 側と同じ意図的な非対称。無条件検証に変えるとここが落ちる。
    const activity = await insertActivity({ userId: ownerId, name: '後でアーカイブ' });
    const plan = await createPlan(activity.id);
    await admin
      .from('activities')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', activity.id);

    const { error } = await admin
      .rpc('update_plan_command_v1', {
        p_user_id: ownerId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_title: 'retitled without touching the activity',
        p_note: dbNull,
        p_activity_id: activity.id as never,
        p_activity_id_present: true,
        p_external_calendar_event_id: dbNull,
        p_start_at: plan.start_at,
        p_end_at: plan.end_at,
      })
      .single();

    expect(error).toBeNull();
  });

  // --- 複合 FK（トリガーを足さずに所有者整合を担保している部分）---

  it('直接 INSERT でも他ユーザーの activity を持つ Plan は書けない', async () => {
    const foreign = await insertActivity({ userId: foreignId, name: '他人' });

    const { error } = await admin.from('plans').insert({
      user_id: ownerId,
      title: 'direct write bypassing the command RPC',
      activity_id: foreign.id,
      source: 'manual',
      start_at: at(60 * 60_000),
      end_at: at(2 * 60 * 60_000),
    });

    expect(error).not.toBeNull();
  });

  it('activity 削除で plans.activity_id だけが NULL 化し、行は残る', async () => {
    const activity = await insertActivity({ userId: ownerId, name: '消す' });
    const plan = await createPlan(activity.id);

    await admin.from('activities').delete().eq('id', activity.id);

    const { data } = await admin
      .from('plans')
      .select('id, user_id, activity_id')
      .eq('id', plan.id)
      .single();
    expect(data?.id).toBe(plan.id);
    expect(data?.user_id).toBe(ownerId);
    expect(data?.activity_id).toBeNull();
  });
});
