import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMcpConnectionsService } from '@/features/settings/server/mcp-connections-service';
import type { Database } from '@/lib/database';

/**
 * `McpConnectionsService.list()` の keyset cursor ページング（issue #1909）を実 DB で検証する。
 *
 * unit test は `.or()` へ渡す**文字列**しか確認できず、mock の返却行は filter / order と
 * 無関係に固定されている。そのため次のいずれかが誤っていても unit test は成功してしまう:
 *
 * - PostgREST の論理式（`and(...)` のネスト）の解釈
 * - timestamptz のテキスト表現と cursor 検証（`isValidCursor`）の食い違い
 * - `(authorized_at DESC, id DESC)` 複合降順と cursor 条件の不整合
 *
 * どれが壊れても症状は同じ「一覧に出ない connection が生まれる = revoke できない」で、
 * これは #1903 / #1909 が閉じようとしている故障そのもの。ここでは実 PostgREST に対して
 * 終端までページングし、**投入した id が過不足なく 1 度ずつ返ること**を固定する。
 */

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

// mcp-connections-service.ts の MCP_LIST_PAGE_SIZE と同じ値。
const PAGE_SIZE = 50;

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ownerClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const resource = 'https://mcp.dayopt.app';
const password = 'test-password-123';

const ownerId = crypto.randomUUID();
const ownerEmail = `mcp-connections-list-owner-${ownerId}@example.com`;

/**
 * ローカル DB へ直接 SQL を流す。`oauth_connections` は authenticated / service_role とも
 * SELECT しか GRANT されておらず（書き込みは SECURITY DEFINER RPC 経由に限定する設計。
 * docs/engineering/data/db/rls-snapshot.md 参照）、Supabase client からは seed できない。
 * `integration-setup.ts` と同じ psql 経路を使う。
 */
function psql(sql: string): string {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8', input: sql },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'psql failed');
  return result.stdout;
}

/**
 * `authorized_at` を明示した connection を一括投入する。
 * `create_oauth_authorization_grant_v2` は `authorized_at` を now() で埋めてしまい、
 * 呼び出しごとに別トランザクション＝別時刻になるため、境界（同値の塊・マイクロ秒差）を
 * 作れない。ここで作りたいのはまさにその境界なので直接 INSERT する。
 *
 * 値はすべてこの関数が生成した uuid と固定の timestamp リテラルで、外部入力は混ざらない。
 */
function insertConnections(authorizedAts: string[]): string[] {
  const ids = authorizedAts.map(() => crypto.randomUUID());
  const values = authorizedAts
    .map(
      (authorizedAt, i) =>
        `('${ids[i]}', '${ownerId}', 'claude-ai', '${resource}', ARRAY['read:entries'], '${authorizedAt}'::timestamptz)`,
    )
    .join(',\n');

  psql(`
    INSERT INTO public.oauth_connections
      (id, user_id, client_id, resource_uri, scopes, authorized_at)
    VALUES
${values};
  `);

  return ids;
}

/** nextCursor が null になるまで実際にページングし、returned した行を順に集める。 */
async function collectAllPages() {
  const service = createMcpConnectionsService(ownerClient);
  const items: Array<{ id: string; authorized_at: string }> = [];
  const pageSizes: number[] = [];
  let cursor: { authorizedAt: string; id: string } | null = null;

  for (let guard = 0; guard <= 20; guard++) {
    const page = await service.list(ownerId, cursor);
    items.push(...page.items);
    pageSizes.push(page.items.length);
    if (!page.nextCursor) return { items, pageSizes };
    cursor = page.nextCursor;
  }

  throw new Error('cursor did not terminate within 20 pages');
}

describe.skipIf(!RUN_LOCAL)('MCP connections list cursor integration', () => {
  beforeAll(async () => {
    const { error: createError } = await admin.auth.admin.createUser({
      id: ownerId,
      email: ownerEmail,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;

    const { error: signInError } = await ownerClient.auth.signInWithPassword({
      email: ownerEmail,
      password,
    });
    if (signInError) throw signInError;
  });

  afterEach(() => {
    psql(`DELETE FROM public.oauth_connections WHERE user_id = '${ownerId}';`);
  });

  afterAll(async () => {
    await ownerClient.auth.signOut();
    await admin.auth.admin.deleteUser(ownerId);
  });

  it('ページ境界を跨いで authorized_at が全件同値でも、全 connection を 1 度ずつ返す', async () => {
    // 最も過酷な tie: 60 件すべてが同一 authorized_at。この場合ページを進められるのは
    // `and(authorized_at.eq.X, id.lt.Y)` 側の枝だけなので、複合比較が壊れていれば
    // 2 ページ目が空になる（欠落）か同じ行を返し続ける（重複・無限ループ）。
    const authorizedAt = '2026-08-01T00:00:00.000000Z';
    const insertedIds = insertConnections(Array.from({ length: 60 }, () => authorizedAt));

    const { items, pageSizes } = await collectAllPages();

    expect(pageSizes).toEqual([PAGE_SIZE, 10]);
    const returnedIds = items.map((row) => row.id);
    expect(returnedIds).toHaveLength(60);
    expect(new Set(returnedIds).size).toBe(60); // 重複なし
    expect(new Set(returnedIds)).toEqual(new Set(insertedIds)); // 欠落なし

    // authorized_at が全件同値なので、並びは id の降順だけで決まる。
    for (let i = 0; i + 1 < returnedIds.length; i++) {
      expect(returnedIds[i]! > returnedIds[i + 1]!).toBe(true);
    }
  });

  it('ページ境界の authorized_at がマイクロ秒しか違わなくても、全 connection を 1 度ずつ返す', async () => {
    // cursor を `new Date().toISOString()` 経由で作るとミリ秒までに丸められ、
    // 同一ミリ秒内の行が次ページで欠落・重複する。DB の生値をそのまま往復させて
    // いることを、境界がマイクロ秒差になる並びで確かめる。
    const base = Date.UTC(2026, 7, 1, 0, 0, 0);
    const authorizedAts = Array.from({ length: 51 }, (_, i) => {
      // 全 51 件が同一ミリ秒に入り、マイクロ秒だけが異なる。
      const micros = String(900_000 + i).padStart(6, '0');
      return `${new Date(base).toISOString().replace('.000Z', '')}.${micros}Z`;
    });
    const insertedIds = insertConnections(authorizedAts);

    const { items, pageSizes } = await collectAllPages();

    expect(pageSizes).toEqual([PAGE_SIZE, 1]);
    const returnedIds = items.map((row) => row.id);
    expect(new Set(returnedIds).size).toBe(51);
    expect(new Set(returnedIds)).toEqual(new Set(insertedIds));

    // 降順（新しい authorized_at が先）であること。
    for (let i = 0; i + 1 < items.length; i++) {
      expect(items[i]!.authorized_at >= items[i + 1]!.authorized_at).toBe(true);
    }
  });

  it('同値の塊がページ境界を跨ぐ混在ケースでも、全 connection を 1 度ずつ返す', async () => {
    // 30 件が T1、30 件が T2（T2 < T1）。1 ページ目は T1 の 30 件 + T2 の 20 件で埋まり、
    // 境界が T2 の塊の内側に落ちる。cursor は `lt` 枝と `and(eq, lt)` 枝の両方を使う。
    const newer = '2026-08-01T12:00:00.000000Z';
    const older = '2026-07-01T12:00:00.000000Z';
    const insertedIds = insertConnections([
      ...Array.from({ length: 30 }, () => newer),
      ...Array.from({ length: 30 }, () => older),
    ]);

    const { items, pageSizes } = await collectAllPages();

    expect(pageSizes).toEqual([PAGE_SIZE, 10]);
    const returnedIds = items.map((row) => row.id);
    expect(new Set(returnedIds).size).toBe(60);
    expect(new Set(returnedIds)).toEqual(new Set(insertedIds));

    // 先頭 30 件が newer、残り 30 件が older（複合降順が保たれている）。
    expect(items.slice(0, 30).every((row) => row.authorized_at === items[0]!.authorized_at)).toBe(
      true,
    );
    expect(items[0]!.authorized_at > items[59]!.authorized_at).toBe(true);
  });

  it('revoke 済み connection は cursor ページングの母集合から外れる', async () => {
    const authorizedAt = '2026-08-01T00:00:00.000000Z';
    const insertedIds = insertConnections(Array.from({ length: 55 }, () => authorizedAt));

    // 1 ページ目に載るはずの行を 5 件 revoke する。母集合が縮んでも
    // 「残っている connection は必ず一覧に出る」ことを確かめる。
    const revokedIds = insertedIds.slice(0, 5);
    psql(`
      UPDATE public.oauth_connections
         SET revoked_at = now(), revoked_reason = 'test'
       WHERE id IN (${revokedIds.map((id) => `'${id}'`).join(',')});
    `);

    const { items } = await collectAllPages();

    const returnedIds = new Set(items.map((row) => row.id));
    expect(returnedIds.size).toBe(50);
    for (const revokedId of revokedIds) expect(returnedIds.has(revokedId)).toBe(false);
    for (const id of insertedIds.slice(5)) expect(returnedIds.has(id)).toBe(true);
  });
});
