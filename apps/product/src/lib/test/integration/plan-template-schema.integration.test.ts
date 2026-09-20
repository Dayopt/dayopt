/**
 * plan_templates / plan_template_blocks の DB 契約と、適用の原子性を固定する（#2567）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * 守りたい契約は 3 つ:
 *
 * 1. **テナント境界**（複合 FK）— 他人の template へ子行を混ぜられない・他人の activity を
 *    保存できない。RLS だけでは子行の親が他人でも通ってしまうため、構造で塞ぐ
 *    （`segment_activities` と同じ形）
 * 2. **寸法を持たない**（v1.0 §5.4）— duration 相当の列が生えた瞬間にこの test が落ちる
 * 3. **適用の原子性** — `create_plans_bulk_command_v1` は 1 件でも失敗したら 0 件で終わる
 */
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const RAW_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** GRANT の外（postgres role）から読む。列一覧・権限の検査に使う。 */
function runOwnerSql(sql: string): string {
  return execFileSync('psql', [RAW_DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: sql,
  }).trim();
}

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
const ownerEmail = `plan-template-owner-${ownerId}@example.com`;
const otherEmail = `plan-template-other-${otherId}@example.com`;

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
/** EXCLUDE 制約（plans_no_overlap）違反。 */
const EXCLUSION_VIOLATION = '23P01';
/** command が入力を拒否した時（22023）。 */
const INVALID_PARAMETER = '22023';
/** アーカイブ済み activity の付与（DT014）。 */
const ACTIVITY_ARCHIVED = 'DT014';
/** RLS / 権限による拒否。WITH CHECK 違反もこれで返る。 */
const RLS_VIOLATION = '42501';

async function createActivity(userId: string, name: string, archived = false): Promise<string> {
  const { data, error } = await admin
    .from('activities')
    .insert({ user_id: userId, name, archived_at: archived ? new Date().toISOString() : null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function createTemplate(userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from('plan_templates')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

function bulkPlan(startAt: string, endAt: string, activityId: string | null = null) {
  return { title: 'ブロック', activity_id: activityId, start_at: startAt, end_at: endAt };
}

async function countPlans(userId: string): Promise<number> {
  const { count, error } = await admin
    .from('plans')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

describe.skipIf(!RUN_LOCAL)('plan_templates schema contract (#2567)', () => {
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
    it('accepts a block whose template and activity are both owned by the writer', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `所有-${crypto.randomUUID()}`);

      const { error } = await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: activityId,
        title: '集中',
        anchor_minute: 540,
      });

      expect(error).toBeNull();
    });

    it('rejects mixing your block into another user’s template', async () => {
      const foreignTemplateId = await createTemplate(otherId, `他人-${crypto.randomUUID()}`);

      const { error } = await admin.from('plan_template_blocks').insert({
        template_id: foreignTemplateId,
        user_id: ownerId,
        activity_id: null,
        title: '侵入',
        anchor_minute: 540,
      });

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('rejects storing another user’s activity in your block', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const foreignActivityId = await createActivity(otherId, `他人-${crypto.randomUUID()}`);

      const { error } = await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: foreignActivityId,
        title: '侵入',
        anchor_minute: 540,
      });

      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('cascades blocks away when the template is deleted', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: '集中',
        anchor_minute: 540,
      });

      const { error: deleteError } = await admin
        .from('plan_templates')
        .delete()
        .eq('id', templateId);
      if (deleteError) throw deleteError;

      const { data, error } = await admin
        .from('plan_template_blocks')
        .select('id')
        .eq('template_id', templateId);
      if (error) throw error;

      expect(data).toEqual([]);
    });

    /** 組成を黙って減らさない。activity を消しても行は残り、title だけが残る。 */
    it('keeps the block (with its title) and nulls activity_id when the activity is deleted', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const activityId = await createActivity(ownerId, `消える-${crypto.randomUUID()}`);
      await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: activityId,
        title: '残るタイトル',
        anchor_minute: 600,
      });

      const { error: deleteError } = await admin.from('activities').delete().eq('id', activityId);
      if (deleteError) throw deleteError;

      const { data, error } = await admin
        .from('plan_template_blocks')
        .select('activity_id, title')
        .eq('template_id', templateId)
        .single();
      if (error) throw error;

      expect(data).toEqual({ activity_id: null, title: '残るタイトル' });
    });
  });

  describe('composition shape', () => {
    it('rejects two blocks on the same anchor within one template', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const row = {
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: '集中',
        anchor_minute: 540,
      };

      const { error: first } = await admin.from('plan_template_blocks').insert(row);
      expect(first).toBeNull();

      const { error: second } = await admin.from('plan_template_blocks').insert(row);
      expect(second?.code).toBe(UNIQUE_VIOLATION);
    });

    it('rejects an anchor outside 0..1439', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);

      const { error } = await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: '集中',
        anchor_minute: 1440,
      });

      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a blank template name and a blank block title', async () => {
      const { error: nameError } = await admin
        .from('plan_templates')
        .insert({ user_id: ownerId, name: '   ' });
      expect(nameError?.code).toBe(CHECK_VIOLATION);

      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const { error: titleError } = await admin.from('plan_template_blocks').insert({
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: '',
        anchor_minute: 540,
      });
      expect(titleError?.code).toBe(CHECK_VIOLATION);
    });

    /**
     * 「寸法を持たない」の機械的な固定（v1.0 §5.4 / §6.4）。duration・interval・
     * 指標・期間の列が生えた瞬間にここが落ちる。
     */
    it('stores composition, order and anchor only — never a dimension', () => {
      const columns = runOwnerSql(
        `SELECT string_agg(column_name, ',' ORDER BY column_name)
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'plan_template_blocks';`,
      ).split(',');

      expect(columns).toEqual([
        'activity_id',
        'anchor_minute',
        'created_at',
        'id',
        'template_id',
        'title',
        'user_id',
      ]);
    });
  });

  describe('privileges', () => {
    it('keeps anon out and denies TRUNCATE to browser roles', () => {
      const result = runOwnerSql(
        `SELECT
           has_table_privilege('anon', 'public.plan_templates', 'SELECT'),
           has_table_privilege('anon', 'public.plan_template_blocks', 'SELECT'),
           has_table_privilege('authenticated', 'public.plan_templates', 'TRUNCATE'),
           has_table_privilege('authenticated', 'public.plan_template_blocks', 'TRUNCATE'),
           has_table_privilege('authenticated', 'public.plan_template_blocks', 'UPDATE');`,
      );

      expect(result).toBe('f|f|f|f|f');
    });
  });

  describe('RLS with real authenticated clients', () => {
    it('allows owner read/delete but rejects direct template and block writes', async () => {
      const client = await signIn(ownerEmail);
      const directTemplateId = crypto.randomUUID();
      const { error: directTemplateInsertError } = await client.from('plan_templates').insert({
        id: directTemplateId,
        user_id: ownerId,
        name: '直接作成は拒否',
      });
      expect(directTemplateInsertError?.code).toBe(RLS_VIOLATION);

      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const directBlockId = crypto.randomUUID();
      const { error: directBlockInsertError } = await client.from('plan_template_blocks').insert({
        id: directBlockId,
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: '直接作成は拒否',
        anchor_minute: 540,
      });
      expect(directBlockInsertError?.code).toBe(RLS_VIOLATION);

      const blockId = crypto.randomUUID();
      const { error: serviceBlockInsertError } = await admin.from('plan_template_blocks').insert({
        id: blockId,
        template_id: templateId,
        user_id: ownerId,
        activity_id: null,
        title: 'service-owned writer',
        anchor_minute: 540,
      });
      expect(serviceBlockInsertError).toBeNull();

      const { error: directTemplateUpdateError } = await client
        .from('plan_templates')
        .update({ name: '直接更新は拒否' })
        .eq('id', templateId);
      expect(directTemplateUpdateError?.code).toBe(RLS_VIOLATION);

      const { data: selectedTemplates, error: templateSelectError } = await client
        .from('plan_templates')
        .select('id')
        .eq('id', templateId);
      const { data: selectedBlocks, error: blockSelectError } = await client
        .from('plan_template_blocks')
        .select('id')
        .eq('id', blockId);
      expect(templateSelectError).toBeNull();
      expect(selectedTemplates).toEqual([{ id: templateId }]);
      expect(blockSelectError).toBeNull();
      expect(selectedBlocks).toEqual([{ id: blockId }]);

      const { data: deletedBlocks, error: blockDeleteError } = await client
        .from('plan_template_blocks')
        .delete()
        .eq('id', blockId)
        .select('id');
      const { data: deletedTemplates, error: templateDeleteError } = await client
        .from('plan_templates')
        .delete()
        .eq('id', templateId)
        .select('id');
      expect(blockDeleteError).toBeNull();
      expect(deletedBlocks).toEqual([{ id: blockId }]);
      expect(templateDeleteError).toBeNull();
      expect(deletedTemplates).toEqual([{ id: templateId }]);
    });

    it('hides another user’s templates and blocks from select', async () => {
      const foreignTemplateId = await createTemplate(otherId, `他人-${crypto.randomUUID()}`);
      await admin.from('plan_template_blocks').insert({
        template_id: foreignTemplateId,
        user_id: otherId,
        activity_id: null,
        title: '他人のブロック',
        anchor_minute: 540,
      });

      const client = await signIn(ownerEmail);
      const { data: templates, error: templatesError } = await client
        .from('plan_templates')
        .select('id')
        .eq('id', foreignTemplateId);
      const { data: blocks, error: blocksError } = await client
        .from('plan_template_blocks')
        .select('id')
        .eq('template_id', foreignTemplateId);

      expect(templatesError).toBeNull();
      expect(templates).toEqual([]);
      expect(blocksError).toBeNull();
      expect(blocks).toEqual([]);
    });

    it('refuses to rename or delete another user’s template', async () => {
      const foreignTemplateId = await createTemplate(otherId, `他人-${crypto.randomUUID()}`);
      const client = await signIn(ownerEmail);

      const { error: renameError } = await client
        .from('plan_templates')
        .update({ name: '乗っ取り' })
        .eq('id', foreignTemplateId)
        .select('id');
      const { data: deleted } = await client
        .from('plan_templates')
        .delete()
        .eq('id', foreignTemplateId)
        .select('id');

      expect(renameError?.code).toBe(RLS_VIOLATION);
      expect(deleted).toEqual([]);

      const { data: survivor, error } = await admin
        .from('plan_templates')
        .select('name')
        .eq('id', foreignTemplateId)
        .single();
      if (error) throw error;
      expect(survivor.name).not.toBe('乗っ取り');
    });

    it('refuses authenticated direct updates even for an owned template', async () => {
      const templateId = await createTemplate(ownerId, `所有-${crypto.randomUUID()}`);
      const client = await signIn(ownerEmail);

      const { data, error } = await client
        .from('plan_templates')
        .update({ user_id: otherId })
        .eq('id', templateId)
        .select('id');

      expect(error?.code).toBe(RLS_VIOLATION);
      expect(data).toBeNull();

      // 所有者が実際に変わっていないことまで見る（エラーの形だけでは移動の有無を証明しない）
      const { data: survivor, error: readError } = await admin
        .from('plan_templates')
        .select('user_id')
        .eq('id', templateId)
        .single();
      if (readError) throw readError;
      expect(survivor.user_id).toBe(ownerId);
    });
  });

  describe('create_plans_bulk_command_v1 (apply atomicity)', () => {
    it('creates every plan in one call', async () => {
      const before = await countPlans(ownerId);

      const { data, error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [
          bulkPlan('2030-01-06T00:00:00Z', '2030-01-06T01:00:00Z'),
          bulkPlan('2030-01-06T02:00:00Z', '2030-01-06T03:00:00Z'),
          bulkPlan('2030-01-06T04:00:00Z', '2030-01-06T05:00:00Z'),
        ],
      });

      expect(error).toBeNull();
      expect(data).toHaveLength(3);
      expect(await countPlans(ownerId)).toBe(before + 3);
    });

    it('creates nothing when a later plan overlaps an existing one', async () => {
      const { error: seedError } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [bulkPlan('2030-02-10T05:00:00Z', '2030-02-10T06:00:00Z')],
      });
      if (seedError) throw seedError;
      const before = await countPlans(ownerId);

      const { error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [
          bulkPlan('2030-02-10T00:00:00Z', '2030-02-10T01:00:00Z'),
          bulkPlan('2030-02-10T05:30:00Z', '2030-02-10T06:30:00Z'),
        ],
      });

      expect(error?.code).toBe(EXCLUSION_VIOLATION);
      expect(await countPlans(ownerId)).toBe(before);
    });

    it('creates nothing when two plans in the same call overlap each other', async () => {
      const before = await countPlans(ownerId);

      const { error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [
          bulkPlan('2030-03-10T00:00:00Z', '2030-03-10T02:00:00Z'),
          bulkPlan('2030-03-10T01:00:00Z', '2030-03-10T03:00:00Z'),
        ],
      });

      expect(error?.code).toBe(EXCLUSION_VIOLATION);
      expect(await countPlans(ownerId)).toBe(before);
    });

    it('allows a plan to start exactly when the previous one ends (half-open range)', async () => {
      const before = await countPlans(ownerId);

      const { error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [
          bulkPlan('2030-04-10T00:00:00Z', '2030-04-10T01:00:00Z'),
          bulkPlan('2030-04-10T01:00:00Z', '2030-04-10T02:00:00Z'),
        ],
      });

      expect(error).toBeNull();
      expect(await countPlans(ownerId)).toBe(before + 2);
    });

    it('creates nothing when a later plan points at an archived activity', async () => {
      const archivedId = await createActivity(ownerId, `凍結-${crypto.randomUUID()}`, true);
      const before = await countPlans(ownerId);

      const { error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [
          bulkPlan('2030-05-10T00:00:00Z', '2030-05-10T01:00:00Z'),
          bulkPlan('2030-05-10T02:00:00Z', '2030-05-10T03:00:00Z', archivedId),
        ],
      });

      expect(error?.code).toBe(ACTIVITY_ARCHIVED);
      expect(await countPlans(ownerId)).toBe(before);
    });

    it('creates nothing when a plan points at another user’s activity', async () => {
      const foreignActivityId = await createActivity(otherId, `他人-${crypto.randomUUID()}`);
      const before = await countPlans(ownerId);

      const { error } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [bulkPlan('2030-06-10T00:00:00Z', '2030-06-10T01:00:00Z', foreignActivityId)],
      });

      expect(error).not.toBeNull();
      expect(await countPlans(ownerId)).toBe(before);
    });

    it('rejects an empty batch and a batch over 50', async () => {
      const before = await countPlans(ownerId);
      const oversized = Array.from({ length: 51 }, (_, index) =>
        bulkPlan(
          `2030-07-${String(10 + Math.floor(index / 20)).padStart(2, '0')}T${String(index % 20).padStart(2, '0')}:00:00Z`,
          `2030-07-${String(10 + Math.floor(index / 20)).padStart(2, '0')}T${String(index % 20).padStart(2, '0')}:30:00Z`,
        ),
      );

      const { error: emptyError } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [],
      });
      const { error: oversizedError } = await admin.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: oversized,
      });

      expect(emptyError?.code).toBe(INVALID_PARAMETER);
      expect(oversizedError?.code).toBe(INVALID_PARAMETER);
      expect(await countPlans(ownerId)).toBe(before);
    });

    it('refuses to run as an authenticated browser client', async () => {
      const client = await signIn(ownerEmail);

      const { error } = await client.rpc('create_plans_bulk_command_v1', {
        p_user_id: ownerId,
        p_plans: [bulkPlan('2030-08-10T00:00:00Z', '2030-08-10T01:00:00Z')],
      });

      expect(error).not.toBeNull();
    });
  });
});
