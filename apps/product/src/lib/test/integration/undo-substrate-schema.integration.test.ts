/**
 * Undo substrate（undo_receipts / _effects / _field_changes）の DB 契約を固定する（#2433）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * 本段（台帳 第2段）は「構造だけ敷いて RPC は第3段」なので、ここで守りたいのは
 * **テナント境界が構造で閉じていること**。Codex B の攻撃シナリオ（#2433）のうち
 * この test が直接反証するのは:
 *
 *   1. 新規 public テーブルの RLS / GRANT 片落ち
 *      → browser role が 3 テーブルへ一切到達できないこと
 *   2. receipt → effect → resource を単一 ID FK だけで結ぶ
 *      → 他人の Plan / Record を自分の receipt へ混ぜられないこと（複合 FK）
 *   3.（構造半分）元操作の authority と receipt tenant の非束縛
 *      → 他人の connection を receipt の origin に指せないこと
 *
 * **GRANT と RLS は別々に判定される**ので、両方を別々に検査する:
 *   - GRANT 層 … 実 anon client（sign-in 済み）で 42501 になること
 *   - RLS 層  … GRANT を一時的に足した transaction の中で policy が実際に絞ることを見て、
 *               ROLLBACK で捨てる。本番の GRANT は閉じたまま policy の正しさだけを測る
 */
import { spawnSync } from 'node:child_process';

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

/** FK 違反。複合 FK が所有者整合を守った時に返る。 */
const FOREIGN_KEY_VIOLATION = '23503';
/** 一意制約違反。 */
const UNIQUE_VIOLATION = '23505';
/** CHECK 違反。 */
const CHECK_VIOLATION = '23514';
/** 権限不足。GRANT を出していないことの現れ。 */
const INSUFFICIENT_PRIVILEGE = '42501';

const UNDO_TABLES = [
  'undo_receipts',
  'undo_receipt_effects',
  'undo_receipt_field_changes',
] as const;

const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const password = 'test-password-123';
const ownerEmail = `undo-substrate-owner-${ownerId}@example.com`;
const otherEmail = `undo-substrate-other-${otherId}@example.com`;

/** 期限は「未来のどこか」であればよい（具体値は第3段の判断、schema は既定値を持たない）。 */
const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function runOwnerSql(sql: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'psql',
    ['-X', '-qAt', '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

async function signIn(email: string) {
  const client = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

/**
 * `plans` / `records` には重なり禁止の EXCLUDE 制約があるので、fixture ごとに
 * 別の時間帯を割り当てる。連番で 1 時間ずつずらすだけでよい。
 */
let fixtureSlot = 0;
function nextSlot(): number {
  fixtureSlot += 1;
  return fixtureSlot;
}

async function createPlan(userId: string): Promise<string> {
  // Plan は未来側に置く。過去に終わる新規は宛先が Record になるため（`resolveTimeblockDestination`）、
  // Plan の fixture は未来側でないと作れない。
  const start = new Date(Date.now() + nextSlot() * 60 * 60 * 1000);
  const { data, error } = await admin
    .from('plans')
    .insert({
      user_id: userId,
      title: 'undo substrate fixture',
      source: 'manual',
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function createRecord(userId: string): Promise<string> {
  // Record は未来に終われない（DB 側の業務ルール）。過去側へ連番でずらす。
  const end = new Date(Date.now() - nextSlot() * 60 * 60 * 1000);
  const { data, error } = await admin
    .from('records')
    .insert({
      user_id: userId,
      title: 'undo substrate fixture',
      source: 'manual',
      start_at: new Date(end.getTime() - 30 * 60 * 1000).toISOString(),
      end_at: end.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function createReceipt(userId: string, commandName = 'records.trim'): Promise<string> {
  const { data, error } = await admin
    .from('undo_receipts')
    .insert({
      user_id: userId,
      operation_id: crypto.randomUUID(),
      command_name: commandName,
      undo_expires_at: futureExpiry(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

describe.skipIf(!RUN_LOCAL)('undo substrate schema contract (#2433)', () => {
  let ownerPlanId: string;
  let ownerRecordId: string;
  let otherPlanId: string;
  let otherRecordId: string;
  let ownerReceiptId: string;

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
    ownerPlanId = await createPlan(ownerId);
    ownerRecordId = await createRecord(ownerId);
    otherPlanId = await createPlan(otherId);
    otherRecordId = await createRecord(otherId);
    ownerReceiptId = await createReceipt(ownerId);
  });

  afterAll(async () => {
    for (const id of [ownerId, otherId]) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  describe('シナリオ1: browser role からの到達（GRANT 層）', () => {
    it('sign-in 済みの authenticated は 3 テーブルを SELECT できない', async () => {
      const client = await signIn(ownerEmail);
      for (const table of UNDO_TABLES) {
        const { error } = await client.from(table).select('user_id').limit(1);
        expect(error?.code, `${table} が authenticated から読めてしまう`).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });

    it('authenticated は 3 テーブルへ INSERT できない（自分の user_id でも）', async () => {
      const client = await signIn(ownerEmail);
      const { error: receiptError } = await client.from('undo_receipts').insert({
        user_id: ownerId,
        operation_id: crypto.randomUUID(),
        command_name: 'forged',
        undo_expires_at: futureExpiry(),
      });
      expect(receiptError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: effectError } = await client.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        plan_id: ownerPlanId,
        effect_kind: 'update',
      });
      expect(effectError?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('authenticated は他人の user_id を指す行も当然 INSERT できない', async () => {
      const client = await signIn(ownerEmail);
      const { error } = await client.from('undo_receipts').insert({
        user_id: otherId,
        operation_id: crypto.randomUUID(),
        command_name: 'forged',
        undo_expires_at: futureExpiry(),
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('anon / authenticated は TRUNCATE も持たない（RLS で防げない権限）', () => {
      const sql = UNDO_TABLES.map(
        (table) =>
          `SELECT has_table_privilege('anon','public.${table}','TRUNCATE')::text || ' ' || has_table_privilege('authenticated','public.${table}','TRUNCATE')::text`,
      ).join(' UNION ALL ');
      const { stdout } = runOwnerSql(sql);
      expect(stdout.split('\n').every((line) => line === 'false false')).toBe(true);
    });
  });

  describe('RLS policy 層（GRANT を閉じたまま policy の正しさを測る）', () => {
    it('owner-scoped SELECT policy が他人の行を隠す', async () => {
      // 他ユーザーの receipt も作っておく（policy が「絞っている」ことを見るため）。
      await createReceipt(otherId);

      // GRANT はこの transaction の中だけ。ROLLBACK で捨てるので本番の権限は閉じたまま。
      const sql = `
        BEGIN;
        GRANT SELECT ON public.undo_receipts TO authenticated;
        SELECT set_config('request.jwt.claims', '{"sub":"${ownerId}","role":"authenticated"}', true);
        SET LOCAL ROLE authenticated;
        SELECT count(*) FILTER (WHERE user_id = '${ownerId}')::text
               || ',' || count(*) FILTER (WHERE user_id <> '${ownerId}')::text
        FROM public.undo_receipts;
        ROLLBACK;
      `;
      const { stdout, stderr, status } = runOwnerSql(sql);
      expect(stderr, 'psql が失敗した').toBe('');
      expect(status).toBe(0);

      const counts = stdout
        .split('\n')
        .filter((line) => /^\d+,\d+$/.test(line))
        .pop();
      expect(counts, 'count 行が取れていない').toBeDefined();
      const [own, others] = counts!.split(',').map(Number);
      expect(own, 'owner 自身の receipt が見えていない（policy が厳しすぎる）').toBeGreaterThan(0);
      expect(others, '他人の receipt が見えている（policy が漏れている）').toBe(0);
    });

    it('ROLLBACK 後、authenticated の SELECT 権限が残っていない', () => {
      const { stdout } = runOwnerSql(
        `SELECT has_table_privilege('authenticated','public.undo_receipts','SELECT')::text;`,
      );
      expect(stdout).toBe('false');
    });
  });

  describe('シナリオ2: receipt → resource の複合 FK', () => {
    it('他人の Plan を自分の receipt の effect にできない', async () => {
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        plan_id: otherPlanId,
        effect_kind: 'update',
      });
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('他人の Record を自分の receipt の effect にできない', async () => {
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        record_id: otherRecordId,
        effect_kind: 'update',
      });
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('他人の receipt に自分の effect をぶら下げられない', async () => {
      const otherReceiptId = await createReceipt(otherId);
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: otherReceiptId,
        plan_id: ownerPlanId,
        effect_kind: 'update',
      });
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('他人の effect に自分の field change をぶら下げられない', async () => {
      const otherReceiptId = await createReceipt(otherId);
      const { data: otherEffect, error: effectError } = await admin
        .from('undo_receipt_effects')
        .insert({
          user_id: otherId,
          receipt_id: otherReceiptId,
          plan_id: otherPlanId,
          effect_kind: 'update',
        })
        .select('id')
        .single();
      if (effectError) throw effectError;

      const { error } = await admin.from('undo_receipt_field_changes').insert({
        user_id: ownerId,
        effect_id: otherEffect.id,
        field_name: 'note',
        before_value: JSON.stringify('before'),
        after_value: JSON.stringify('after'),
      });
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('自分の resource なら通る（拒否だけでなく正常系も固定する）', async () => {
      const receiptId = await createReceipt(ownerId);
      const { data, error } = await admin
        .from('undo_receipt_effects')
        .insert({
          user_id: ownerId,
          receipt_id: receiptId,
          plan_id: ownerPlanId,
          effect_kind: 'update',
        })
        .select('id, resource_type')
        .single();
      expect(error).toBeNull();
      expect(data?.resource_type).toBe('plan');

      const { data: recordEffect, error: recordError } = await admin
        .from('undo_receipt_effects')
        .insert({
          user_id: ownerId,
          receipt_id: receiptId,
          record_id: ownerRecordId,
          effect_kind: 'delete',
        })
        .select('resource_type')
        .single();
      expect(recordError).toBeNull();
      expect(recordEffect?.resource_type).toBe('record');
    });
  });

  describe('シナリオ3（構造半分）: receipt の origin authority', () => {
    it('存在しない / 他人の connection を origin に指せない', async () => {
      const { error } = await admin.from('undo_receipts').insert({
        user_id: ownerId,
        operation_id: crypto.randomUUID(),
        command_name: 'records.trim',
        undo_expires_at: futureExpiry(),
        origin_connection_id: crypto.randomUUID(),
      });
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  describe('resource の指定形（polymorphic 単一 ID を採らなかったことの帰結）', () => {
    it('plan も record も指定しない effect は作れない', async () => {
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        effect_kind: 'update',
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('plan と record を同時に指定した effect は作れない', async () => {
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        plan_id: ownerPlanId,
        record_id: ownerRecordId,
        effect_kind: 'update',
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('effect_kind は insert / update / delete の 3 値だけ', async () => {
      const { error } = await admin.from('undo_receipt_effects').insert({
        user_id: ownerId,
        receipt_id: ownerReceiptId,
        // 契約外の値を意図的に送る（この tsconfig は strict: false なので型では止まらない。
        // 止めるのは DB の CHECK 制約であり、それを確認するのがこの test）
        effect_kind: 'upsert' as 'insert',
        plan_id: ownerPlanId,
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('同一 receipt が同じ Plan を 2 回含められない', async () => {
      const receiptId = await createReceipt(ownerId);
      const insertEffect = () =>
        admin.from('undo_receipt_effects').insert({
          user_id: ownerId,
          receipt_id: receiptId,
          plan_id: ownerPlanId,
          effect_kind: 'update',
        });
      expect((await insertEffect()).error).toBeNull();
      expect((await insertEffect()).error?.code).toBe(UNIQUE_VIOLATION);
    });

    it('同一 receipt に record だけの effect は複数入る（NULL は distinct）', async () => {
      const receiptId = await createReceipt(ownerId);
      const secondRecordId = await createRecord(ownerId);
      for (const recordId of [ownerRecordId, secondRecordId]) {
        const { error } = await admin.from('undo_receipt_effects').insert({
          user_id: ownerId,
          receipt_id: receiptId,
          record_id: recordId,
          effect_kind: 'update',
        });
        expect(error).toBeNull();
      }
    });
  });

  describe('receipt 自体の契約', () => {
    it('同一 (user_id, operation_id) の receipt は二重に作れない（T3 exactly-once）', async () => {
      const operationId = crypto.randomUUID();
      const insertReceipt = () =>
        admin.from('undo_receipts').insert({
          user_id: ownerId,
          operation_id: operationId,
          command_name: 'records.trim',
          undo_expires_at: futureExpiry(),
        });
      expect((await insertReceipt()).error).toBeNull();
      expect((await insertReceipt()).error?.code).toBe(UNIQUE_VIOLATION);
    });

    it('別ユーザーなら同じ operation_id を使える（一意性は user 単位）', async () => {
      const operationId = crypto.randomUUID();
      for (const userId of [ownerId, otherId]) {
        const { error } = await admin.from('undo_receipts').insert({
          user_id: userId,
          operation_id: operationId,
          command_name: 'records.trim',
          undo_expires_at: futureExpiry(),
        });
        expect(error).toBeNull();
      }
    });

    it('undone_at / undone_operation_id は片方だけ立てられない', async () => {
      const { error } = await admin.from('undo_receipts').insert({
        user_id: ownerId,
        operation_id: crypto.randomUUID(),
        command_name: 'records.trim',
        undo_expires_at: futureExpiry(),
        undone_at: new Date().toISOString(),
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('command_name は空白だけでは作れない', async () => {
      const { error } = await admin.from('undo_receipts').insert({
        user_id: ownerId,
        operation_id: crypto.randomUUID(),
        command_name: '   ',
        undo_expires_at: futureExpiry(),
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it('undo_expires_at に既定値が無い（TTL の具体値は第3段の判断）', () => {
      const { stdout } = runOwnerSql(`
        SELECT coalesce(column_default, 'NO DEFAULT')
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'undo_receipts'
          AND column_name = 'undo_expires_at';
      `);
      expect(stdout).toBe('NO DEFAULT');
    });
  });

  describe('Plan / Record の物理削除に対する追従', () => {
    it('Plan を物理削除すると、その effect も CASCADE で消える', async () => {
      const planId = await createPlan(ownerId);
      const receiptId = await createReceipt(ownerId);
      const { data: effect, error: insertError } = await admin
        .from('undo_receipt_effects')
        .insert({
          user_id: ownerId,
          receipt_id: receiptId,
          plan_id: planId,
          effect_kind: 'update',
        })
        .select('id')
        .single();
      if (insertError) throw insertError;

      await admin.from('plans').delete().eq('id', planId);

      const { data } = await admin.from('undo_receipt_effects').select('id').eq('id', effect.id);
      expect(data).toEqual([]);
    });
  });
});
