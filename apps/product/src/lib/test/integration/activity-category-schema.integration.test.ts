/**
 * activities / categories の DB 契約を固定する（epic #2162 Step 1）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * ここで固定するのは「所有者整合をトリガーではなく複合 FK で担保する」という
 * 設計判断そのもの。tags 側には同種の test が 1 本も無く、置き換えの前後で
 * 同じ保証が維持されたことを機械的に示せない状態だった（#2162 の設計凍結で
 * 指摘された検証の空白）。Step 3 で plans / records を activity 参照へ切り替える
 * 際、この test が活きた基準になる。
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

const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const password = 'test-password-123';
const ownerEmail = `activity-schema-owner-${ownerId}@example.com`;
const otherEmail = `activity-schema-other-${otherId}@example.com`;

/** FK 違反。複合 FK が所有者整合を守った時に返る。 */
const FOREIGN_KEY_VIOLATION = '23503';
/** 一意制約違反。部分 UNIQUE index が同名を弾いた時に返る。 */
const UNIQUE_VIOLATION = '23505';

async function createCategory(userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from('categories')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function signIn(email: string) {
  const client = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

describe.skipIf(!RUN_LOCAL)('activities / categories schema contract (#2162)', () => {
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
    it('rejects an activity that points at another user’s category', async () => {
      const foreignCategoryId = await createCategory(otherId, `他人-${crypto.randomUUID()}`);

      const { error } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: foreignCategoryId, name: '侵入' });

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    /**
     * トリガー案では守れない側。子側の AFTER トリガーは親の user_id 変更を
     * 観測できないため、複合 FK を選んだ理由がここに現れる。
     */
    it('rejects reassigning an activity to another user while it keeps its category', async () => {
      const categoryId = await createCategory(ownerId, `所有-${crypto.randomUUID()}`);
      const { data: activity, error: insertError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: categoryId, name: '通常' })
        .select('id')
        .single();
      if (insertError) throw insertError;

      const { error } = await admin
        .from('activities')
        .update({ user_id: otherId })
        .eq('id', activity.id);

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    /**
     * #2162 の P1 回帰テスト。未分類側に UNIQUE (user_id, name) を置くと、この
     * DELETE が 23505 で abort し、カテゴリーが二度と削除できなくなっていた。
     * index を置かないことで「SET NULL が失敗しうる」クラスごと無くしてある。
     */
    it('deletes a category even when its activity name collides with an uncategorized one', async () => {
      const name = `衝突-${crypto.randomUUID()}`;

      const { error: uncategorizedError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, name });
      if (uncategorizedError) throw uncategorizedError;

      const categoryId = await createCategory(ownerId, `衝突元-${crypto.randomUUID()}`);
      const { error: categorizedError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: categoryId, name });
      if (categorizedError) throw categorizedError;

      const { error } = await admin.from('categories').delete().eq('id', categoryId);
      expect(error).toBeNull();

      const { data: survivors } = await admin
        .from('activities')
        .select('category_id, user_id')
        .eq('user_id', ownerId)
        .eq('name', name);

      expect(survivors).toHaveLength(2);
      expect(survivors?.every((row) => row.category_id === null)).toBe(true);
      expect(survivors?.every((row) => row.user_id === ownerId)).toBe(true);
    });

    it('nulls only category_id when the category is deleted, keeping the owner', async () => {
      const categoryId = await createCategory(ownerId, `消える-${crypto.randomUUID()}`);
      const { data: activity, error: insertError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: categoryId, name: '残る' })
        .select('id')
        .single();
      if (insertError) throw insertError;

      const { error: deleteError } = await admin.from('categories').delete().eq('id', categoryId);
      expect(deleteError).toBeNull();

      const { data: after, error } = await admin
        .from('activities')
        .select('category_id, user_id')
        .eq('id', activity.id)
        .single();
      if (error) throw error;

      expect(after.category_id).toBeNull();
      expect(after.user_id).toBe(ownerId);
    });
  });

  describe('name uniqueness (partial unique indexes)', () => {
    it('allows the same name under different categories', async () => {
      const first = await createCategory(ownerId, `仕事-${crypto.randomUUID()}`);
      const second = await createCategory(ownerId, `学習-${crypto.randomUUID()}`);
      const name = `レビュー-${crypto.randomUUID()}`;

      const { error: firstError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: first, name });
      expect(firstError).toBeNull();

      const { error: secondError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, category_id: second, name });

      expect(secondError).toBeNull();
    });

    /**
     * 未分類の同名は意図的に許す。tags_user_root_name_unique に倣って UNIQUE を
     * 置くと、カテゴリー削除の ON DELETE SET NULL が未分類の同名と衝突して
     * DELETE ごと abort し、そのカテゴリーが二度と削除できなくなる（#2162）。
     * 上の "deletes a category even when ..." がその削除経路を固定している。
     */
    it('allows the same name among uncategorized activities', async () => {
      const name = `雑務-${crypto.randomUUID()}`;

      const { error: firstError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, name });
      expect(firstError).toBeNull();

      const { error } = await admin.from('activities').insert({ user_id: ownerId, name });

      expect(error).toBeNull();
    });

    it('frees the name once the activity is archived', async () => {
      const name = `再利用-${crypto.randomUUID()}`;
      const { data: activity, error: insertError } = await admin
        .from('activities')
        .insert({ user_id: ownerId, name })
        .select('id')
        .single();
      if (insertError) throw insertError;

      const { error: archiveError } = await admin
        .from('activities')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', activity.id);
      expect(archiveError).toBeNull();

      const { error } = await admin.from('activities').insert({ user_id: ownerId, name });

      expect(error).toBeNull();
    });

    it('rejects a duplicate category name for the same user', async () => {
      const name = `重複-${crypto.randomUUID()}`;
      await createCategory(ownerId, name);

      const { error } = await admin.from('categories').insert({ user_id: ownerId, name });

      expect(error?.code).toBe(UNIQUE_VIOLATION);
    });
  });

  describe('row level security', () => {
    it('hides another user’s categories and activities from an authenticated client', async () => {
      const categoryId = await createCategory(otherId, `秘密-${crypto.randomUUID()}`);
      const { error: insertError } = await admin
        .from('activities')
        .insert({ user_id: otherId, category_id: categoryId, name: '秘密作業' });
      if (insertError) throw insertError;

      const ownerClient = await signIn(ownerEmail);

      const { data: categories, error: categoryError } = await ownerClient
        .from('categories')
        .select('id')
        .eq('id', categoryId);
      expect(categoryError).toBeNull();
      expect(categories).toEqual([]);

      const { data: activities, error: activityError } = await ownerClient
        .from('activities')
        .select('id')
        .eq('user_id', otherId);
      expect(activityError).toBeNull();
      expect(activities).toEqual([]);
    });

    it('refuses to insert a row owned by someone else', async () => {
      const ownerClient = await signIn(ownerEmail);

      const { error } = await ownerClient
        .from('categories')
        .insert({ user_id: otherId, name: `なりすまし-${crypto.randomUUID()}` });

      expect(error).not.toBeNull();
    });
  });

  describe('grants', () => {
    /**
     * production の pg_default_acl は新規 public テーブルに anon/authenticated へ
     * ほぼ全権限を撒くため、migration の REVOKE が効いていることをアプリ側からも
     * 確かめる。migration 内の invariant が一次ゲートで、これはその二重化。
     */
    it('does not expose the tables to anon', async () => {
      const anonClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { error: selectError } = await anonClient.from('categories').select('id').limit(1);
      expect(selectError).not.toBeNull();

      const { error: insertError } = await anonClient
        .from('activities')
        .insert({ user_id: ownerId, name: 'anon' });
      expect(insertError).not.toBeNull();
    });
  });
});
