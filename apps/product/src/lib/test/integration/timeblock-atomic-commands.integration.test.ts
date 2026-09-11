import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `timeblock-commands-${userId}@example.com`;
const password = 'test-password-123';
const dbNull = null as never;

type PlanRow = Database['public']['Tables']['plans']['Row'];
type RecordRow = Database['public']['Tables']['records']['Row'];

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sameMillisecondDifferentVersion(version: string): string {
  const normalized = version.endsWith('Z') ? version.replace(/Z$/, '+00:00') : version;
  const match = normalized.match(/^(.*?)(?:\.(\d{1,6}))?([+-]\d{2}:?\d{2})$/);
  if (!match) throw new Error(`Unexpected timestamptz: ${version}`);

  const [, whole, fraction = '', offset] = match;
  const micros = fraction.padEnd(6, '0');
  const finalDigit = micros.at(-1) === '9' ? '8' : '9';
  return `${whole}.${micros.slice(0, -1)}${finalDigit}${offset}`;
}

async function createPlan(input: {
  title: string;
  startAt: string;
  endAt: string;
  source?: 'manual' | 'api';
}): Promise<PlanRow> {
  const { data, error } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: input.title,
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: input.source ?? 'manual',
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
  if (error) throw error;
  return data;
}

async function createRecord(input: {
  title: string;
  startAt: string;
  endAt: string;
  source?: 'manual' | 'api';
  planId?: string | null;
}): Promise<RecordRow> {
  const { data, error } = await admin
    .rpc('create_record_command_v1', {
      p_user_id: userId,
      p_title: input.title,
      p_note: dbNull,
      p_plan_id: (input.planId ?? null) as never,
      p_external_calendar_event_id: dbNull,
      p_source: input.source ?? 'manual',
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
  if (error) throw error;
  return data;
}

function planUpdateArgs(plan: PlanRow, title: string, expectedUpdatedAt = plan.updated_at) {
  return {
    p_user_id: userId,
    p_plan_id: plan.id,
    p_expected_updated_at: expectedUpdatedAt,
    p_title: title,
    p_note: plan.note as never,
    p_external_calendar_event_id: plan.external_calendar_event_id as never,
    p_start_at: plan.start_at,
    p_end_at: plan.end_at,
  };
}

function recordUpdateArgs(record: RecordRow, title: string, expectedUpdatedAt = record.updated_at) {
  return {
    p_user_id: userId,
    p_record_id: record.id,
    p_expected_updated_at: expectedUpdatedAt,
    p_title: title,
    p_note: record.note as never,
    p_plan_id: dbNull,
    p_external_calendar_event_id: record.external_calendar_event_id as never,
    p_start_at: record.start_at,
    p_end_at: record.end_at,
  };
}

describe.skipIf(!RUN_LOCAL)('atomic Plan and Record command boundary', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
  });

  afterEach(async () => {
    await admin.from('records').delete().eq('user_id', userId);
    await admin.from('plans').delete().eq('user_id', userId);
  });

  afterAll(async () => {
    await userClient.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  it('does not expose service-owned commands to authenticated clients', async () => {
    const { error } = await userClient.rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: 'Forbidden direct RPC',
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: at(60 * 60_000),
      p_end_at: at(2 * 60 * 60_000),
    });

    expect(error?.code).toBe('42501');

    const { error: confirmError } = await userClient.rpc('confirm_day_plans_command_v1', {
      p_user_id: userId,
      p_start_at: at(-24 * 60 * 60_000),
      p_end_at: at(24 * 60 * 60_000),
      p_confirmed_at: at(0),
    });
    expect(confirmError?.code).toBe('42501');
  });

  it('rejects confirm-day ranges longer than 26 hours', async () => {
    const { error } = await admin.rpc('confirm_day_plans_command_v1', {
      p_user_id: userId,
      p_start_at: '2026-07-01T00:00:00.000Z',
      p_end_at: '2026-07-02T02:00:00.001Z',
    });

    expect(error?.code).toBe('22023');
  });

  it('places and moves Plans anywhere on the timeline, and rejects retired skip', async () => {
    // 過去に終わる Plan を作れる
    const pastPlan = await createPlan({
      title: 'Yesterday',
      startAt: at(-30 * 60 * 60_000),
      endAt: at(-29 * 60 * 60_000),
    });

    // 過去 Plan の時刻を過去の範囲内で動かせる
    const correctedStartAt = at(-28 * 60 * 60_000);
    const { data: movedInPast, error: movedInPastError } = await admin
      .rpc('update_plan_command_v1', {
        ...planUpdateArgs(pastPlan, 'Yesterday, corrected'),
        p_start_at: correctedStartAt,
        p_end_at: at(-27 * 60 * 60_000),
      })
      .single();
    expect(movedInPastError).toBeNull();
    expect(new Date(movedInPast!.start_at).getTime()).toBe(new Date(correctedStartAt).getTime());

    // 過去 Plan を未来へ動かせる
    const { data: movedToFuture, error: movedToFutureError } = await admin
      .rpc('update_plan_command_v1', {
        ...planUpdateArgs(movedInPast!, 'Rescheduled'),
        p_start_at: at(30 * 60 * 60_000),
        p_end_at: at(31 * 60 * 60_000),
      })
      .single();
    expect(movedToFutureError).toBeNull();

    // contract後の旧クライアントには、保存状態を作らず撤去案内を返す
    const { error: skipError } = await admin.rpc('set_plan_skipped_command_v1', {
      p_user_id: userId,
      p_plan_id: movedToFuture!.id,
      p_expected_updated_at: movedToFuture!.updated_at,
      p_skipped: true,
    });
    expect(skipError?.code).toBe('DT012');
  });

  it('serializes concurrent Plan updates with exact compare-and-swap', async () => {
    const plan = await createPlan({
      title: 'Original',
      startAt: at(60 * 60_000),
      endAt: at(2 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      admin.rpc('update_plan_command_v1', planUpdateArgs(plan, 'Writer A')).single(),
      admin.rpc('update_plan_command_v1', planUpdateArgs(plan, 'Writer B')).single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(attempts.filter(({ error }) => error?.code === 'DT002')).toHaveLength(1);

    const { data: persisted, error } = await admin
      .from('plans')
      .select('title, updated_at')
      .eq('id', plan.id)
      .single();
    expect(error).toBeNull();
    expect(['Writer A', 'Writer B']).toContain(persisted?.title);
    expect(persisted?.updated_at).not.toBe(plan.updated_at);
  });

  it('allows only one of a same-version Plan update and delete', async () => {
    const plan = await createPlan({
      title: 'Update or delete',
      startAt: at(8 * 60 * 60_000),
      endAt: at(9 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      admin.rpc('update_plan_command_v1', planUpdateArgs(plan, 'Updated')).single(),
      admin
        .rpc('delete_plan_command_v1', {
          p_user_id: userId,
          p_plan_id: plan.id,
          p_expected_updated_at: plan.updated_at,
        })
        .single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['DT001', 'DT002'].includes(error?.code ?? '')),
    ).toHaveLength(1);
  });

  it('serializes concurrent Record updates with exact compare-and-swap', async () => {
    const record = await createRecord({
      title: 'Original record',
      startAt: at(-4 * 60 * 60_000),
      endAt: at(-3 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      admin.rpc('update_record_command_v1', recordUpdateArgs(record, 'Record A')).single(),
      admin.rpc('update_record_command_v1', recordUpdateArgs(record, 'Record B')).single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(attempts.filter(({ error }) => error?.code === 'DT002')).toHaveLength(1);
  });

  it('does not collapse sub-millisecond versions through JavaScript Date', async () => {
    const plan = await createPlan({
      title: 'Precise version',
      startAt: at(3 * 60 * 60_000),
      endAt: at(4 * 60 * 60_000),
    });
    const wrongVersion = sameMillisecondDifferentVersion(plan.updated_at);

    expect(new Date(wrongVersion).getTime()).toBe(new Date(plan.updated_at).getTime());
    const { error } = await admin
      .rpc('update_plan_command_v1', planUpdateArgs(plan, 'Must conflict', wrongVersion))
      .single();

    expect(error?.code).toBe('DT002');
  });

  it('lets only one of simultaneous UI and MCP Plan creates occupy a range', async () => {
    const startAt = at(5 * 60 * 60_000);
    const endAt = at(6 * 60 * 60_000);
    const base = {
      p_user_id: userId,
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_start_at: startAt,
      p_end_at: endAt,
    };

    const attempts = await Promise.all([
      admin.rpc('create_plan_command_v1', { ...base, p_title: 'UI', p_source: 'manual' }).single(),
      admin.rpc('create_plan_command_v1', { ...base, p_title: 'MCP', p_source: 'api' }).single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);

    const adjacent = await createPlan({
      title: 'Adjacent',
      startAt: endAt,
      endAt: at(7 * 60 * 60_000),
      source: 'api',
    });
    expect(new Date(adjacent.start_at).getTime()).toBe(new Date(endAt).getTime());
  });

  // #1985: useConvertGhostEvent はタップのたびに ghost の同じ start_at/end_at を複製して
  // create_plan_command_v1 / create_record_command_v1 を呼ぶ。external_calendar_event_id に
  // 専用の unique 制約は無いため、二重変換の防止は plans_no_overlap（時間帯 EXCLUDE 制約）の
  // 副作用に過ぎない（risk-reviewer 指摘）。この副作用が実際に効くことをここで固定する。
  it('lets only one of two simultaneous conversions of the same ghost create a Plan', async () => {
    const startAt = at(8 * 60 * 60_000);
    const endAt = at(9 * 60 * 60_000);

    const { data: ghost, error: ghostError } = await admin
      .from('external_calendar_events')
      .insert({
        user_id: userId,
        provider: 'google',
        provider_calendar_id: 'primary',
        provider_event_id: `evt-double-convert-${crypto.randomUUID()}`,
        title: 'Ghost double-convert race',
        start_at: startAt,
        end_at: endAt,
        status: 'confirmed',
        last_synced_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (ghostError) throw ghostError;

    try {
      const base = {
        p_user_id: userId,
        p_note: dbNull,
        p_external_calendar_event_id: ghost.id,
        p_start_at: startAt,
        p_end_at: endAt,
      };

      const attempts = await Promise.all([
        admin
          .rpc('create_plan_command_v1', {
            ...base,
            p_title: 'Ghost title',
            p_source: 'external_calendar',
          })
          .single(),
        admin
          .rpc('create_plan_command_v1', {
            ...base,
            p_title: 'Ghost title',
            p_source: 'external_calendar',
          })
          .single(),
      ]);

      expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
      expect(
        attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
      ).toHaveLength(1);
    } finally {
      await admin.from('external_calendar_events').delete().eq('id', ghost.id);
    }
  });

  it('allows either Plan restore or an overlapping create, never both', async () => {
    const startAt = at(10 * 60 * 60_000);
    const endAt = at(11 * 60 * 60_000);
    const plan = await createPlan({ title: 'Plan trash candidate', startAt, endAt });
    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();

    const attempts = await Promise.all([
      admin
        .rpc('restore_plan_command_v1', {
          p_user_id: userId,
          p_plan_id: plan.id,
          p_expected_updated_at: deleted!.updated_at,
        })
        .single(),
      admin
        .rpc('create_plan_command_v1', {
          p_user_id: userId,
          p_title: 'Competing Plan',
          p_note: dbNull,
          p_external_calendar_event_id: dbNull,
          p_source: 'api',
          p_start_at: startAt,
          p_end_at: endAt,
        })
        .single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);
  });

  it('lets only one of simultaneous UI and MCP Record creates occupy a range', async () => {
    const startAt = at(-6 * 60 * 60_000);
    const endAt = at(-5 * 60 * 60_000);
    const base = {
      p_user_id: userId,
      p_note: dbNull,
      p_plan_id: dbNull,
      p_external_calendar_event_id: dbNull,
      p_start_at: startAt,
      p_end_at: endAt,
    };

    const attempts = await Promise.all([
      admin
        .rpc('create_record_command_v1', { ...base, p_title: 'UI', p_source: 'manual' })
        .single(),
      admin.rpc('create_record_command_v1', { ...base, p_title: 'MCP', p_source: 'api' }).single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);

    const adjacent = await createRecord({
      title: 'Adjacent',
      startAt: endAt,
      endAt: at(-4 * 60 * 60_000),
      source: 'api',
    });
    expect(new Date(adjacent.start_at).getTime()).toBe(new Date(endAt).getTime());
  });

  it('allows a Plan and Record to occupy the same time across separate lanes', async () => {
    const sharedStartAt = at(-60 * 60_000);
    const plan = await createPlan({
      title: 'Cross-lane Plan',
      startAt: sharedStartAt,
      endAt: at(60 * 60_000),
      source: 'api',
    });
    const record = await createRecord({
      title: 'Cross-lane Record',
      startAt: sharedStartAt,
      endAt: at(-1_000),
      source: 'api',
    });

    expect(plan.id).not.toBe(record.id);
  });

  it('rejects future Records and ignores the drained legacy link argument', async () => {
    const plan = await createPlan({
      title: 'Future link target',
      startAt: at(60 * 60_000),
      endAt: at(2 * 60 * 60_000),
    });
    const base = {
      p_user_id: userId,
      p_title: 'Record error contract',
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'api',
    };

    const { error: futureRecordError } = await admin.rpc('create_record_command_v1', {
      ...base,
      p_plan_id: dbNull,
      p_start_at: at(60 * 60_000),
      p_end_at: at(2 * 60 * 60_000),
    });
    const { data: legacyRecord, error: futurePlanError } = await admin
      .rpc('create_record_command_v1', {
        ...base,
        p_plan_id: plan.id,
        p_start_at: at(-2 * 60 * 60_000),
        p_end_at: at(-60 * 60_000),
      })
      .single();
    expect(futureRecordError?.code).toBe('DT005');
    expect(futurePlanError).toBeNull();
    expect(legacyRecord).not.toHaveProperty('plan_id');
  });

  it('allows either Record restore or overlapping create, never both', async () => {
    const startAt = at(-9 * 60 * 60_000);
    const endAt = at(-8 * 60 * 60_000);
    const record = await createRecord({ title: 'Trash candidate', startAt, endAt });
    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: record.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();

    const attempts = await Promise.all([
      admin
        .rpc('restore_record_command_v1', {
          p_user_id: userId,
          p_record_id: record.id,
          p_expected_updated_at: deleted!.updated_at,
        })
        .single(),
      admin
        .rpc('create_record_command_v1', {
          p_user_id: userId,
          p_title: 'Competing create',
          p_note: dbNull,
          p_plan_id: dbNull,
          p_external_calendar_event_id: dbNull,
          p_source: 'api',
          p_start_at: startAt,
          p_end_at: endAt,
        })
        .single(),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);
  });

  it('retired skip request cannot affect an independently created Record', async () => {
    const plan = await createPlan({
      title: 'Independent',
      startAt: at(-4 * 60 * 60_000),
      endAt: at(-3 * 60 * 60_000),
    });
    const [record, skip] = await Promise.all([
      createRecord({ title: 'Independent record', startAt: plan.start_at, endAt: plan.end_at }),
      admin.rpc('set_plan_skipped_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_skipped: true,
      }),
    ]);
    expect(record.id).toBeTruthy();
    expect(skip.error?.code).toBe('DT012');
    const { data } = await admin.from('plans').select('id').eq('id', plan.id).single();
    expect(data?.id).toBe(plan.id);
  });

  it('serializes confirm-day against one-tap Plan recording', async () => {
    const plan = await createPlan({
      title: 'Confirm day race',
      startAt: at(-2_000),
      endAt: at(1_500),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const attempts = await Promise.all([
      admin.rpc('confirm_day_plans_command_v1', {
        p_user_id: userId,
        p_start_at: at(-12 * 60 * 60_000),
        p_end_at: at(12 * 60 * 60_000),
        p_confirmed_at: at(0),
      }),
      admin
        .rpc('record_plan_command_v1', {
          p_user_id: userId,
          p_plan_id: plan.id,
          p_expected_updated_at: plan.updated_at,
        })
        .single(),
    ]);

    expect(attempts.every(({ error }) => error === null || error.code === '23P01')).toBe(true);
    expect(attempts.some(({ error }) => error === null)).toBe(true);

    const { data: linkedRecords, error } = await admin
      .from('records')
      .select('id')
      .eq('user_id', userId)
      .eq('start_at', plan.start_at)
      .is('deleted_at', null);
    expect(error).toBeNull();
    expect(linkedRecords).toHaveLength(1);
  });

  it('restores an independent Record after a retired skip request', async () => {
    const plan = await createPlan({
      title: 'Restore invariant',
      startAt: at(-2_000),
      endAt: at(1_500),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const { error: genericFromPlanError } = await admin.rpc('create_record_command_v1', {
      p_user_id: userId,
      p_title: 'Forbidden generic from_plan',
      p_note: dbNull,
      p_plan_id: plan.id,
      p_external_calendar_event_id: dbNull,
      p_source: 'from_plan',
      p_start_at: plan.start_at,
      p_end_at: plan.end_at,
    });
    expect(genericFromPlanError?.code).toBe('DT012');

    const { error: nullSkipError } = await admin.rpc('set_plan_skipped_command_v1', {
      p_user_id: userId,
      p_plan_id: plan.id,
      p_expected_updated_at: plan.updated_at,
      p_skipped: dbNull,
    });
    expect(nullSkipError?.code).toBe('DT012');

    const { data: record, error: recordError } = await admin
      .rpc('record_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(recordError).toBeNull();

    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record!.id,
        p_expected_updated_at: record!.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();

    const { error: skipError } = await admin
      .rpc('set_plan_skipped_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_skipped: true,
      })
      .single();
    expect(skipError?.code).toBe('DT012');

    const { error: restoreError } = await admin
      .rpc('restore_record_command_v1', {
        p_user_id: userId,
        p_record_id: record!.id,
        p_expected_updated_at: deleted!.updated_at,
      })
      .single();
    expect(restoreError).toBeNull();
  });

  it('keeps auto-migrated Records immutable for service-role commands', async () => {
    const { data: record, error: insertError } = await admin
      .from('records')
      .insert({
        user_id: userId,
        title: 'Legacy import',
        source: 'auto_migrated',
        start_at: at(-12 * 60 * 60_000),
        end_at: at(-11 * 60 * 60_000),
      })
      .select()
      .single();
    expect(insertError).toBeNull();

    const { error: updateError } = await admin
      .rpc('update_record_command_v1', recordUpdateArgs(record!, 'Forbidden update'))
      .single();
    expect(updateError?.code).toBe('DT009');

    const { error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record!.id,
        p_expected_updated_at: record!.updated_at,
      })
      .single();
    expect(deleteError?.code).toBe('DT009');

    const { data: tombstone, error: tombstoneError } = await admin
      .from('records')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', record!.id)
      .select()
      .single();
    expect(tombstoneError).toBeNull();

    const { error: restoreError } = await admin
      .rpc('restore_record_command_v1', {
        p_user_id: userId,
        p_record_id: record!.id,
        p_expected_updated_at: tombstone!.updated_at,
      })
      .single();
    expect(restoreError?.code).toBe('DT009');
  });

  // risk-reviewer が Step 8（tag_id 剥離、#2352）のレビューで検出した pre-existing bug の
  // 回帰固定。confirm_day_plans_unserialized_v1 が record_plan_unserialized_v1（Plan を
  // 1 件ずつ「記録する」）と非対称に activity_id をコピーしていなかった
  // （20260824095706 で修正）。
  it('confirm day plans が生成する Record は Plan の activity_id を引き継ぐ', async () => {
    const { data: activity, error: activityError } = await admin
      .from('activities')
      .insert({ user_id: userId, name: `Confirm day activity ${crypto.randomUUID()}` })
      .select()
      .single();
    expect(activityError).toBeNull();

    const { data: plan, error: planError } = await admin
      .rpc('create_plan_command_v1', {
        p_user_id: userId,
        p_title: 'Confirm day plan',
        p_note: dbNull,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(-2_000),
        p_end_at: at(1_500),
        p_activity_id: activity!.id,
      })
      .single();
    expect(planError).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const { data: confirmed, error: confirmError } = await admin.rpc(
      'confirm_day_plans_command_v1',
      {
        p_user_id: userId,
        p_start_at: at(-12 * 60 * 60_000),
        p_end_at: at(0),
        p_confirmed_at: at(0),
      },
    );
    expect(confirmError).toBeNull();

    const record = confirmed?.find((row) => row.start_at === plan!.start_at);
    expect(record?.activity_id).toBe(activity!.id);
  });
});
