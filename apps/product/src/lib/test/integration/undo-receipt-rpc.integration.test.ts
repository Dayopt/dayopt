/**
 * Undo receipt substrate の書き込み経路（RPC 3 本）を固定する（#2434、台帳 第3段）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * 第2段（undo-substrate-schema.integration.test.ts）はテナント境界（GRANT/RLS/複合FK）
 * を守る。本 test は**書き込み・Undo適用そのものの契約**を守る:
 *
 *   1. 「Undo は元操作より強い権限や広い user scope を得ない」（issue #2434 必須不変条件）
 *      - revoke済みconnection・reauth待ち・scope不足・connection物理削除の4パターンで拒否
 *      - UI由来（origin_connection_id NULL）は常に許可（scope概念が無い）
 *   2. CAS は field mask 内に限定される
 *      - mask内フィールドが変更されていれば失敗（正）、mask外の変更は妨げない（負）
 *   3. 欠損検査（受け入れ後にeffectがCASCADEで欠けた receipt をsilent successにしない）
 *   4. 冪等性（record/apply とも同一operation_idの再送で最初の結果を返す）
 *   5. insert effectのundo(=DELETE)とdelete effect_kindの構造的拒否
 */
import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const INSUFFICIENT_PRIVILEGE = '42501';
/** 既存 fixture の resource_uri（mcp_environment_identity）。読み取り専用で参照する。 */
const MCP_RESOURCE_URI = 'https://mcp.dayopt.app';

function runSql(sql: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'psql',
    ['-X', '-qAt', '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

/** `plans` の重なり禁止 EXCLUDE 制約を避けるため、fixture ごとに時間帯をずらす。 */
let fixtureSlot = 0;
function nextSlot(): number {
  fixtureSlot += 1;
  return fixtureSlot;
}

async function createPlan(userId: string, title = 'undo rpc fixture'): Promise<string> {
  const start = new Date(Date.now() + nextSlot() * 60 * 60 * 1000);
  const { data, error } = await admin
    .from('plans')
    .insert({
      user_id: userId,
      title,
      source: 'manual',
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/** Record は未来に終われない（DB 側の業務ルール）ので、過去側へ連番でずらす。 */
async function createRecord(userId: string, title = 'undo rpc fixture'): Promise<string> {
  const end = new Date(Date.now() - nextSlot() * 60 * 60 * 1000);
  const { data, error } = await admin
    .from('records')
    .insert({
      user_id: userId,
      title,
      source: 'manual',
      start_at: new Date(end.getTime() - 30 * 60 * 1000).toISOString(),
      end_at: end.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/** insert effect の undo(=DELETE) は full mask 契約を要求する。plan/record それぞれの全列。 */
const PLAN_FULL_MASK = ['deleted_at', 'end_at', 'note', 'start_at', 'title'] as const;
const RECORD_FULL_MASK = ['deleted_at', 'end_at', 'note', 'start_at', 'title'] as const;

type EffectInput = {
  plan_id?: string;
  record_id?: string;
  effect_kind: 'insert' | 'update' | 'delete';
  field_changes: { field_name: string; before_value: unknown; after_value: unknown }[];
};

async function recordReceipt(args: {
  userId: string;
  operationId?: string;
  commandName?: string;
  isMcpCommand?: boolean;
  originConnectionId?: string | null;
  ttlSeconds?: number;
  effects: EffectInput[];
}): Promise<string> {
  const originConnectionId = args.originConnectionId ?? null;
  const { data, error } = await admin.rpc('record_undo_receipt_v1', {
    p_user_id: args.userId,
    p_operation_id: args.operationId ?? crypto.randomUUID(),
    p_command_name: args.commandName ?? 'test.command',
    p_is_mcp_command: args.isMcpCommand ?? originConnectionId !== null,
    p_origin_connection_id: originConnectionId,
    p_undo_ttl_seconds: args.ttlSeconds ?? 3600,
    p_effects: args.effects as never,
  });
  if (error) throw error;
  return data as string;
}

function applyReceipt(userId: string, receiptId: string, applyOperationId?: string) {
  return admin.rpc('apply_undo_receipt_v1', {
    p_user_id: userId,
    p_receipt_id: receiptId,
    p_apply_operation_id: applyOperationId ?? crypto.randomUUID(),
  });
}

function listUndoable(userId: string) {
  return admin.rpc('list_undoable_receipts_v1', { p_user_id: userId });
}

async function getPlan(planId: string) {
  const { data, error } = await admin
    .from('plans')
    .select('title, note, start_at, end_at, deleted_at')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getRecord(recordId: string) {
  const { data, error } = await admin
    .from('records')
    .select('title, note, start_at, end_at, deleted_at')
    .eq('id', recordId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** insert effect の full mask 用の field_changes（作成時の値を after_value に置く）。 */
/**
 * insert effect の full mask 契約を満たす field_changes を、実際に作成された行の
 * 現在値から組み立てる。before_value は常に null（挿入前は存在しなかった）、
 * after_value は行の実値（timestamp 等の NOT NULL 列を null で偽装すると CAS が
 * 恒久的に不一致になるため、必ず実際に作成された値を使う）。
 */
function fullMaskFieldChanges(
  resourceType: 'plan' | 'record',
  currentRow: Record<string, unknown>,
): { field_name: string; before_value: unknown; after_value: unknown }[] {
  const fields = resourceType === 'plan' ? PLAN_FULL_MASK : RECORD_FULL_MASK;
  return fields.map((field_name) => ({
    field_name,
    before_value: null,
    after_value: currentRow[field_name] ?? null,
  }));
}

/**
 * oauth_connections は service_role でもSELECT以外の直接DMLを閉じている
 * （typed SECURITY DEFINER RPC 専用）。fixture 作成は owner（postgres）で行う。
 */
function createConnection(args: { userId: string; scopes: string[] }): string {
  const needsWriteGate = args.scopes.some((scope) =>
    ['write:plans', 'delete:plans', 'write:records', 'delete:records'].includes(scope),
  );
  const id = crypto.randomUUID();
  const scopesLiteral = `ARRAY[${args.scopes.map((scope) => `'${scope}'`).join(', ')}]::TEXT[]`;
  const result = runSql(
    `INSERT INTO public.oauth_connections (id, user_id, client_id, resource_uri, scopes${needsWriteGate ? ', write_enabled_at' : ''}) ` +
      `VALUES ('${id}', '${args.userId}', 'unknown', '${MCP_RESOURCE_URI}', ${scopesLiteral}${needsWriteGate ? ', now()' : ''})`,
  );
  if (result.status !== 0) throw new Error(`createConnection failed: ${result.stderr}`);
  return id;
}

function revokeConnection(id: string) {
  const result = runSql(
    `UPDATE public.oauth_connections SET revoked_at = now(), revoked_reason = 'test' WHERE id = '${id}'`,
  );
  if (result.status !== 0) throw new Error(`revokeConnection failed: ${result.stderr}`);
}

function expireConnectionReauth(id: string) {
  // reauth_required_at は authorized_at より後でなければならない
  // （oauth_connections_reauth_after_authorization CHECK）ため、
  // authorized_at の直後かつ現在時刻より前の値へ設定する。
  const result = runSql(
    `UPDATE public.oauth_connections SET reauth_required_at = authorized_at + interval '1 millisecond' WHERE id = '${id}'`,
  );
  if (result.status !== 0) throw new Error(`expireConnectionReauth failed: ${result.stderr}`);
}

function deleteConnection(id: string) {
  const result = runSql(`DELETE FROM public.oauth_connections WHERE id = '${id}'`);
  if (result.status !== 0) throw new Error(`deleteConnection failed: ${result.stderr}`);
}

const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const password = 'test-password-123';
const ownerEmail = `undo-rpc-owner-${ownerId}@example.com`;
const otherEmail = `undo-rpc-other-${otherId}@example.com`;

describe.skipIf(!RUN_LOCAL)('undo receipt RPC (#2434)', () => {
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
    for (const id of [ownerId, otherId]) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  describe('happy path・冪等性', () => {
    it('update effectを記録してapplyするとbefore_valueへ戻る', async () => {
      const planId = await createPlan(ownerId);
      await admin
        .from('plans')
        .update({ title: 'after edit', note: 'after note' })
        .eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'before edit', after_value: 'after edit' },
              { field_name: 'note', before_value: 'before note', after_value: 'after note' },
            ],
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();

      const plan = await getPlan(planId);
      expect(plan?.title).toBe('before edit');
      expect(plan?.note).toBe('before note');
    });

    it('record_undo_receipt_v1は同一operation_idの再送で最初のreceiptをそのまま返す', async () => {
      const planId = await createPlan(ownerId);
      const operationId = crypto.randomUUID();
      const effects: EffectInput[] = [
        {
          plan_id: planId,
          effect_kind: 'update',
          field_changes: [{ field_name: 'title', before_value: 'x', after_value: 'y' }],
        },
      ];

      const first = await recordReceipt({ userId: ownerId, operationId, effects });
      const second = await recordReceipt({ userId: ownerId, operationId, effects });
      expect(second).toBe(first);

      const { count } = await admin
        .from('undo_receipts')
        .select('id', { count: 'exact', head: true })
        .eq('operation_id', operationId);
      expect(count).toBe(1);
    });

    it('apply_undo_receipt_v1は同一apply_operation_idの再送を冪等に成功させる', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'edited' }).eq('id', planId);
      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [{ field_name: 'title', before_value: 'orig', after_value: 'edited' }],
          },
        ],
      });
      const applyOperationId = crypto.randomUUID();

      const first = await applyReceipt(ownerId, receiptId, applyOperationId);
      expect(first.error).toBeNull();
      const second = await applyReceipt(ownerId, receiptId, applyOperationId);
      expect(second.error).toBeNull();
    });

    it('apply_undo_receipt_v1は別のapply_operation_idでの再undoを拒否する', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'edited2' }).eq('id', planId);
      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [{ field_name: 'title', before_value: 'orig2', after_value: 'edited2' }],
          },
        ],
      });

      await applyReceipt(ownerId, receiptId);
      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();
    });
  });

  describe('DoD: CAS はfield mask内に限定される（正負）', () => {
    it('【正】mask内フィールドが元操作後に変更されていればall-or-nothingで失敗する', async () => {
      const planA = await createPlan(ownerId);
      const planB = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'a-after' }).eq('id', planA);
      await admin.from('plans').update({ title: 'b-after' }).eq('id', planB);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planA,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'a-before', after_value: 'a-after' },
            ],
          },
          {
            plan_id: planB,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'b-before', after_value: 'b-after' },
            ],
          },
        ],
      });

      // planBのmask内フィールドを元操作後にさらに変更する。
      await admin.from('plans').update({ title: 'b-tampered' }).eq('id', planB);

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();

      // all-or-nothing: planA（CASは通ったはず）も戻っていないこと。
      const planAAfter = await getPlan(planA);
      expect(planAAfter?.title).toBe('a-after');
    });

    it('【負】mask外フィールドの変更はUndoを妨げない', async () => {
      const planId = await createPlan(ownerId);
      await admin
        .from('plans')
        .update({ title: 'masked-after', note: 'original note' })
        .eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'masked-before', after_value: 'masked-after' },
            ],
          },
        ],
      });

      // noteはmask外。元操作後に正当に編集されてもUndoを妨げない。
      await admin
        .from('plans')
        .update({ note: 'edited after receipt, not masked' })
        .eq('id', planId);

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();

      const plan = await getPlan(planId);
      expect(plan?.title).toBe('masked-before');
      expect(plan?.note).toBe('edited after receipt, not masked');
    });
  });

  describe('insert effect の undo（= DELETE）と delete effect_kind の拒否', () => {
    it('insert effectのundoは対象行を削除する', async () => {
      const planId = await createPlan(ownerId, 'created via command');
      const created = await getPlan(planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'insert',
            field_changes: fullMaskFieldChanges('plan', created ?? {}),
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();

      const plan = await getPlan(planId);
      expect(plan).toBeNull();
    });

    it('effect_kind=deleteはrecord時点で拒否される（構造的に記録トランザクションを生き残れないため）', async () => {
      const planId = await createPlan(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          effects: [
            {
              plan_id: planId,
              effect_kind: 'delete',
              field_changes: [{ field_name: 'title', before_value: 'x', after_value: null }],
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it('write:plansは持つがdelete:plansを持たないconnectionはinsert effectのundo(=DELETE)を拒否される（元操作より強い権限を得ない非対称性）', async () => {
      // update effectのundo（書き戻し）はwrite:*で足りるが、insert effectのundo（DELETE）は
      // delete:*を要求する。この非対称性そのものが「Undoは元操作より強い権限を得ない」の
      // 核心なので、write:plansだけを持つconnectionでは拒否されることを直接固定する。
      const connectionId = createConnection({
        userId: ownerId,
        scopes: ['read:entries', 'write:plans'],
      });
      const planId = await createPlan(ownerId, 'created via write-only connection');
      const created = await getPlan(planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: connectionId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'insert',
            field_changes: fullMaskFieldChanges('plan', created ?? {}),
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();

      // 拒否された結果、行は消えていないことも確認する（部分適用が無いこと）。
      const plan = await getPlan(planId);
      expect(plan).not.toBeNull();

      deleteConnection(connectionId);
    });

    it('クロスレビューP2: insert effectを部分maskで記録するとrecord時点で拒否される', async () => {
      // mask外への正当な事後編集がundo(=DELETE)に巻き込まれ silent に消えるのを防ぐため、
      // insert effectはresource_typeの全maskを揃えることを記録時に強制する。
      const planId = await createPlan(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          effects: [
            {
              plan_id: planId,
              effect_kind: 'insert',
              field_changes: [
                { field_name: 'title', before_value: null, after_value: 'partial mask' },
              ],
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it('撤去済みskipped_atのfield_changeを新規receiptへ記録できない', async () => {
      // 撤去済み列を受理すると、一覧ではUndo可能に見えてapply時に失敗するため、
      // resource種別にかかわらず記録時点で拒否する。
      const recordId = await createRecord(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          effects: [
            {
              record_id: recordId,
              effect_kind: 'update',
              field_changes: [{ field_name: 'skipped_at', before_value: null, after_value: null }],
            },
          ],
        }),
      ).rejects.toThrow();
    });
  });

  describe('欠損検査: CASCADEでeffectが欠けたreceiptをsilent successにしない', () => {
    it('記録後にeffectが消えるとapplyは失敗し、一覧からも除外される', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'orphan-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'orphan-before', after_value: 'orphan-after' },
            ],
          },
        ],
      });

      // 単発の物理削除やCASCADE経路を模す: effect行だけを直接消す。
      const { error: deleteError } = await admin
        .from('undo_receipt_effects')
        .delete()
        .eq('receipt_id', receiptId);
      expect(deleteError).toBeNull();

      const { error: applyError } = await applyReceipt(ownerId, receiptId);
      expect(applyError).not.toBeNull();

      const { data: listed } = await listUndoable(ownerId);
      expect(listed?.some((row) => row.id === receiptId)).toBe(false);
    });
  });

  describe('TTL', () => {
    it('undo_expires_atを過ぎたreceiptはapply不可・一覧からも除外される', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'ttl-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        ttlSeconds: 1,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'ttl-before', after_value: 'ttl-after' },
            ],
          },
        ],
      });

      const { error: updateError } = await admin
        .from('undo_receipts')
        .update({ undo_expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq('id', receiptId);
      expect(updateError).toBeNull();

      const { error: applyError } = await applyReceipt(ownerId, receiptId);
      expect(applyError).not.toBeNull();

      const { data: listed } = await listUndoable(ownerId);
      expect(listed?.some((row) => row.id === receiptId)).toBe(false);
    });
  });

  describe('DoD: 権限は「実行者の現在の有効権限」∩「元操作時の権限上限」の交差のみ', () => {
    it('UI由来（origin_connection_id無し）はscope概念を持たず常に許可される', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'ui-after' }).eq('id', planId);
      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: null,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'ui-before', after_value: 'ui-after' },
            ],
          },
        ],
      });
      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();
    });

    it('クロスレビューP2: is_mcp_command=trueなのにorigin_connection_idを省略すると拒否される', async () => {
      // origin_connection_idの省略を「UI由来」へ暗黙変換すると、MCP発行のcommandが
      // 引数を渡し忘れた時に権限交差判定が丸ごとskipされ黙って昇格する（fail-open）。
      // 明示フラグとorigin_connection_idの有無が矛盾する場合はrecord時点で拒否する。
      const planId = await createPlan(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          isMcpCommand: true,
          originConnectionId: null,
          effects: [
            {
              plan_id: planId,
              effect_kind: 'update',
              field_changes: [{ field_name: 'title', before_value: 'x', after_value: 'y' }],
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it('クロスレビューP2: is_mcp_command=falseなのにorigin_connection_idを指定すると拒否される', async () => {
      const connectionId = createConnection({
        userId: ownerId,
        scopes: ['read:entries', 'write:plans'],
      });
      const planId = await createPlan(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          isMcpCommand: false,
          originConnectionId: connectionId,
          effects: [
            {
              plan_id: planId,
              effect_kind: 'update',
              field_changes: [{ field_name: 'title', before_value: 'x', after_value: 'y' }],
            },
          ],
        }),
      ).rejects.toThrow();
      deleteConnection(connectionId);
    });

    it('revoke済みconnectionからのreceiptはTTL内でもUndo不可', async () => {
      const connectionId = createConnection({
        userId: ownerId,
        scopes: ['read:entries', 'write:plans'],
      });
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'revoke-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: connectionId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'revoke-before', after_value: 'revoke-after' },
            ],
          },
        ],
      });

      revokeConnection(connectionId);

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();

      deleteConnection(connectionId);
    });

    it('reauth待ち（reauth_required_atを過ぎた）connectionからのreceiptはUndo不可', async () => {
      const connectionId = createConnection({
        userId: ownerId,
        scopes: ['read:entries', 'write:plans'],
      });
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'reauth-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: connectionId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'reauth-before', after_value: 'reauth-after' },
            ],
          },
        ],
      });

      expireConnectionReauth(connectionId);

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();

      deleteConnection(connectionId);
    });

    it('scope不足（write:plansを持たない）connectionからのreceiptはUndo不可', async () => {
      const connectionId = createConnection({ userId: ownerId, scopes: ['read:entries'] });
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'scope-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: connectionId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'title', before_value: 'scope-before', after_value: 'scope-after' },
            ],
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();

      deleteConnection(connectionId);
    });

    it('connectionが記録後に物理削除されると revoke 相当としてUndo不可（had_origin_connection の防御）', async () => {
      const connectionId = createConnection({
        userId: ownerId,
        scopes: ['read:entries', 'write:plans'],
      });
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'deleted-conn-after' }).eq('id', planId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        originConnectionId: connectionId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              {
                field_name: 'title',
                before_value: 'deleted-conn-before',
                after_value: 'deleted-conn-after',
              },
            ],
          },
        ],
      });

      // retention cleanupと同じ経路: connectionを物理削除する（ON DELETE SET NULL）。
      deleteConnection(connectionId);

      const { data: receiptRow } = await admin
        .from('undo_receipts')
        .select('had_origin_connection, origin_connection_id')
        .eq('id', receiptId)
        .single();
      expect(receiptRow?.had_origin_connection).toBe(true);
      expect(receiptRow?.origin_connection_id).toBeNull();

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();
    });
  });

  describe('他人のreceiptには到達できない', () => {
    it('他人が作ったreceiptはp_user_id不一致でapply/list両方から見えない', async () => {
      const planId = await createPlan(ownerId);
      await admin.from('plans').update({ title: 'isolation-after' }).eq('id', planId);
      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            plan_id: planId,
            effect_kind: 'update',
            field_changes: [
              {
                field_name: 'title',
                before_value: 'isolation-before',
                after_value: 'isolation-after',
              },
            ],
          },
        ],
      });

      const { error } = await applyReceipt(otherId, receiptId);
      expect(error).not.toBeNull();

      const { data: listed } = await listUndoable(otherId);
      expect(listed?.some((row) => row.id === receiptId)).toBe(false);
    });
  });

  describe('field_name allowlist', () => {
    it('allowlist外のfield_nameはrecord時点で拒否される', async () => {
      const planId = await createPlan(ownerId);
      await expect(
        recordReceipt({
          userId: ownerId,
          effects: [
            {
              plan_id: planId,
              effect_kind: 'update',
              field_changes: [{ field_name: 'user_id', before_value: 'x', after_value: 'y' }],
            },
          ],
        }),
      ).rejects.toThrow();
    });
  });

  describe('クロスレビューP2: recordリソース・timestamptz列の網羅', () => {
    it('recordリソースのstart_at/end_at（timestamptz）でCAS正負が機能する', async () => {
      const recordId = await createRecord(ownerId);
      const original = await getRecord(recordId);
      const newStart = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const newEnd = new Date(Date.now() - 4.5 * 60 * 60 * 1000).toISOString();
      await admin.from('records').update({ start_at: newStart, end_at: newEnd }).eq('id', recordId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            record_id: recordId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'start_at', before_value: original?.start_at, after_value: newStart },
              { field_name: 'end_at', before_value: original?.end_at, after_value: newEnd },
            ],
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();

      const restored = await getRecord(recordId);
      // JSONB経由（to_jsonb -> #>>'{}' -> ::timestamptz）でも往復精度が失われないこと。
      expect(new Date(restored?.start_at ?? '').getTime()).toBe(
        new Date(original?.start_at ?? '').getTime(),
      );
      expect(new Date(restored?.end_at ?? '').getTime()).toBe(
        new Date(original?.end_at ?? '').getTime(),
      );
    });

    it('recordリソースのinsert effect(undo=DELETE)もfull mask契約を満たせば成立する', async () => {
      const recordId = await createRecord(ownerId, 'created record via command');
      const created = await getRecord(recordId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            record_id: recordId,
            effect_kind: 'insert',
            field_changes: fullMaskFieldChanges('record', created ?? {}),
          },
        ],
      });

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).toBeNull();

      const record = await getRecord(recordId);
      expect(record).toBeNull();
    });

    it('timestamptzフィールドがmask内で改変されているとCASが失敗する（recordリソース）', async () => {
      const recordId = await createRecord(ownerId);
      const original = await getRecord(recordId);
      const newEnd = new Date(Date.now() - 4.5 * 60 * 60 * 1000).toISOString();
      await admin.from('records').update({ end_at: newEnd }).eq('id', recordId);

      const receiptId = await recordReceipt({
        userId: ownerId,
        effects: [
          {
            record_id: recordId,
            effect_kind: 'update',
            field_changes: [
              { field_name: 'end_at', before_value: original?.end_at, after_value: newEnd },
            ],
          },
        ],
      });

      // maskしたend_atをUndo実行までの間にさらに変更する。
      await admin
        .from('records')
        .update({ end_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() })
        .eq('id', recordId);

      const { error } = await applyReceipt(ownerId, receiptId);
      expect(error).not.toBeNull();
    });
  });

  describe('function-level GRANT不変条件（第2段のtable版DOブロックのfunction拡張）', () => {
    it('anon/authenticatedは3公開RPCへEXECUTEを持たない', () => {
      for (const fn of [
        'record_undo_receipt_v1(uuid,uuid,text,boolean,uuid,integer,jsonb)',
        'apply_undo_receipt_v1(uuid,uuid,uuid)',
        'list_undoable_receipts_v1(uuid)',
      ]) {
        const anonResult = runSql(
          `SELECT has_function_privilege('anon', 'public.${fn}', 'EXECUTE')`,
        );
        expect(anonResult.stdout, `${fn} EXECUTE check failed: ${anonResult.stderr}`).toBe('f');

        const authResult = runSql(
          `SELECT has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE')`,
        );
        expect(authResult.stdout, `${fn} EXECUTE check failed: ${authResult.stderr}`).toBe('f');
      }
    });
  });
});
