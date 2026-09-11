/**
 * segments / segment_activities の DB 契約を固定する（epic #2162 Step 5）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * activity-category-schema.integration.test.ts が所属軸（categories / activities）の
 * 所有者整合を固定するのに対し、こちらは**横断参照軸**を固定する。セグメントは
 * 所属ではないので多対多で、1 アクティビティが複数セグメントに入ってよい。その
 * ゆるさがテナント境界まで緩まないこと（他人のアクティビティを自分のセグメントへ
 * 混ぜられないこと）が、ここで守りたい一番の契約。
 *
 * あわせて「レポートビルダーに育てない」ための構造制約（#2162 §6-4）も固定する。
 * segments に期間・指標・並べ替えの列が無いことは、列を足す変更が入った瞬間に
 * この test が落ちることで検出する。
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * 実 anon client でサインインして返す。
 *
 * service-role client は RLS を素通りするため、上の複合 FK の検証は通っても
 * 「RLS が他人の行を隠すか」は 1 ミリも証明していない。そこだけは実 client で見る。
 * `segments` 本体は rls-access.integration.test.ts の matrix にも登録したが、
 * `segment_activities` は複合 PK で matrix の型（単一 idColumn）に合わないため、
 * ここで個別に見る。
 */
async function signIn(email: string) {
  const client = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const password = 'test-password-123';
const ownerEmail = `segment-schema-owner-${ownerId}@example.com`;
const otherEmail = `segment-schema-other-${otherId}@example.com`;

/** FK 違反。複合 FK が所有者整合を守った時に返る。 */
const FOREIGN_KEY_VIOLATION = '23503';
/** 一意制約違反。複合 PK / UNIQUE が弾いた時に返る。 */
const UNIQUE_VIOLATION = '23505';
/** CHECK 違反。空白のみの名前を弾いた時に返る。 */
const CHECK_VIOLATION = '23514';

async function createActivity(userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from('activities')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function createSegment(userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from('segments')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

describe.skipIf(!RUN_LOCAL)('segments / segment_activities schema contract (#2162)', () => {
  beforeAll(async () => {
    for (const [id, email] of [
      [ownerId, ownerEmail],
      [otherId, otherEmail],
    ] as const) {
      const { error } = await admin.auth.admin.createUser({
        id,
        email,
        password,
        email_confirm: true,
      });
      if (error) throw error;
    }
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(ownerId);
    await admin.auth.admin.deleteUser(otherId);
  });

  describe('owner integrity (composite FK, no triggers)', () => {
    it('accepts an activity the segment owner owns', async () => {
      const segmentId = await createSegment(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `所有-${crypto.randomUUID()}`);

      const { error } = await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: activityId });

      expect(error).toBeNull();
    });

    it('rejects putting another user’s activity into your own segment', async () => {
      const segmentId = await createSegment(ownerId, `所有-${crypto.randomUUID()}`);
      const foreignActivityId = await createActivity(otherId, `他人-${crypto.randomUUID()}`);

      const { error } = await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: foreignActivityId });

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('rejects putting your activity into another user’s segment', async () => {
      const foreignSegmentId = await createSegment(otherId, `他人-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `所有-${crypto.randomUUID()}`);

      const { error } = await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: foreignSegmentId, activity_id: activityId });

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  describe('membership shape', () => {
    it('rejects registering the same activity into the same segment twice', async () => {
      const segmentId = await createSegment(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `所有-${crypto.randomUUID()}`);
      const row = { user_id: ownerId, segment_id: segmentId, activity_id: activityId };

      const { error: first } = await admin.from('segment_activities').insert(row);
      expect(first).toBeNull();

      const { error: second } = await admin.from('segment_activities').insert(row);
      expect(second?.code).toBe(UNIQUE_VIOLATION);
    });

    /**
     * セグメントが「所属」ではなく「横断参照」であることの実体。所属軸
     * （activities.category_id）は単一所属なので、この形は取れない。
     */
    it('allows one activity to belong to multiple segments', async () => {
      const activityId = await createActivity(ownerId, `共有-${crypto.randomUUID()}`);
      const deepId = await createSegment(ownerId, `深い仕事-${crypto.randomUUID()}`);
      const soloId = await createSegment(ownerId, `単独作業-${crypto.randomUUID()}`);

      const { error } = await admin.from('segment_activities').insert([
        { user_id: ownerId, segment_id: deepId, activity_id: activityId },
        { user_id: ownerId, segment_id: soloId, activity_id: activityId },
      ]);

      expect(error).toBeNull();
    });

    it('cascades membership rows away when the segment is deleted', async () => {
      const segmentId = await createSegment(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `所有-${crypto.randomUUID()}`);
      await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: activityId });

      const { error: deleteError } = await admin.from('segments').delete().eq('id', segmentId);
      if (deleteError) throw deleteError;

      const { data, error } = await admin
        .from('segment_activities')
        .select('segment_id')
        .eq('segment_id', segmentId);
      if (error) throw error;

      expect(data).toEqual([]);
    });

    it('keeps the activity itself alive after its segment is deleted', async () => {
      const segmentId = await createSegment(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `残存-${crypto.randomUUID()}`);
      await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: activityId });

      await admin.from('segments').delete().eq('id', segmentId);

      const { data, error } = await admin
        .from('activities')
        .select('id')
        .eq('id', activityId)
        .single();
      if (error) throw error;

      expect(data.id).toBe(activityId);
    });
  });

  describe('segment naming', () => {
    it('rejects a blank name', async () => {
      const { error } = await admin.from('segments').insert({ user_id: ownerId, name: '   ' });

      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a duplicate name for the same user', async () => {
      const name = `重複-${crypto.randomUUID()}`;
      await createSegment(ownerId, name);

      const { error } = await admin.from('segments').insert({ user_id: ownerId, name });

      expect(error?.code).toBe(UNIQUE_VIOLATION);
    });

    it('allows the same name across different users', async () => {
      const name = `同名-${crypto.randomUUID()}`;
      await createSegment(ownerId, name);

      const { error } = await admin.from('segments').insert({ user_id: otherId, name });

      expect(error).toBeNull();
    });
  });

  /**
   * RLS を実 anon client で確認する。ここまでの test は service-role client なので
   * RLS を素通りしており、行レベルの遮蔽については何も証明していない。
   */
  describe('RLS with real authenticated clients', () => {
    it('hides another user’s segment_activities rows from select', async () => {
      const foreignSegment = await createSegment(otherId, `他人-${crypto.randomUUID()}`);
      const foreignActivity = await createActivity(otherId, `他人-${crypto.randomUUID()}`);
      await admin.from('segment_activities').insert({
        user_id: otherId,
        segment_id: foreignSegment,
        activity_id: foreignActivity,
      });

      const client = await signIn(ownerEmail);
      const { data, error } = await client
        .from('segment_activities')
        .select('segment_id')
        .eq('segment_id', foreignSegment);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('refuses to delete another user’s segment_activities rows', async () => {
      const foreignSegment = await createSegment(otherId, `他人-${crypto.randomUUID()}`);
      const foreignActivity = await createActivity(otherId, `他人-${crypto.randomUUID()}`);
      await admin.from('segment_activities').insert({
        user_id: otherId,
        segment_id: foreignSegment,
        activity_id: foreignActivity,
      });

      const client = await signIn(ownerEmail);
      await client.from('segment_activities').delete().eq('segment_id', foreignSegment);

      // service-role で見て、実際に残っていることを確認する
      const { data } = await admin
        .from('segment_activities')
        .select('segment_id')
        .eq('segment_id', foreignSegment);
      expect(data).toHaveLength(1);
    });

    /** UPDATE は grant も policy も与えていない。メンバーは消して入れ直す設計。 */
    it('does not allow updating a membership row', async () => {
      const segmentId = await createSegment(ownerId, `更新不可-${crypto.randomUUID()}`);
      const a1 = await createActivity(ownerId, `旧-${crypto.randomUUID()}`);
      const a2 = await createActivity(ownerId, `新-${crypto.randomUUID()}`);
      await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: a1 });

      const client = await signIn(ownerEmail);
      await client
        .from('segment_activities')
        .update({ activity_id: a2 })
        .eq('segment_id', segmentId);

      const { data } = await admin
        .from('segment_activities')
        .select('activity_id')
        .eq('segment_id', segmentId)
        .single();
      expect(data?.activity_id).toBe(a1);
    });
  });

  /**
   * #2162 §6-4「セグメントに保存させるのはアクティビティの集合だけ」の構造的担保。
   * 期間・指標・グルーピングの列を足す変更が入ったらここで落ちる。
   */
  describe('report-builder guard', () => {
    it('stores nothing but the activity set (no period / metric / ordering columns)', async () => {
      const segmentId = await createSegment(ownerId, `列検査-${crypto.randomUUID()}`);

      const { data, error } = await admin.from('segments').select('*').eq('id', segmentId).single();
      if (error) throw error;

      expect(Object.keys(data).sort()).toEqual([
        'created_at',
        'id',
        'name',
        'updated_at',
        'user_id',
      ]);
    });

    it('stores only the membership pair (no per-membership settings)', async () => {
      const segmentId = await createSegment(ownerId, `列検査-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `列検査-${crypto.randomUUID()}`);
      await admin
        .from('segment_activities')
        .insert({ user_id: ownerId, segment_id: segmentId, activity_id: activityId });

      const { data, error } = await admin
        .from('segment_activities')
        .select('*')
        .eq('segment_id', segmentId)
        .single();
      if (error) throw error;

      expect(Object.keys(data).sort()).toEqual(['activity_id', 'segment_id', 'user_id']);
    });
  });
});
