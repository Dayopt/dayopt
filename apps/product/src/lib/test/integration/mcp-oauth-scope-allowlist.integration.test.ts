import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
// barrel は SUPPORTED_SCOPES を公開しない（外へ出すのは同値の ADVERTISED_SCOPES 側）
// ので leaf を直接読む。この定数こそが 4 箇所の唯一の期待値なので、テスト側で
// 別の配列に写し取らない。
import { SUPPORTED_SCOPES } from '@/lib/oauth-server/scopes';

/**
 * OAuth scope の allowlist が **4 箇所すべてで** TS の `SUPPORTED_SCOPES` と一致する
 * ことを固定する（#2174）。
 *
 * scope を 1 つ足す / 外す作業は、CHECK 制約 3 本と
 * `create_oauth_authorization_grant_v2` の本体という 4 箇所を同時に動かす必要がある。
 * 壊れ方が箇所ごとに違うのが厄介で、
 *
 *   - CHECK だけ直して関数を漏らす → 新規接続が 22023 で失敗する（保存以前に作れない）
 *   - 関数だけ直して CHECK を漏らす → grant は作れるが INSERT が 23514 で落ちる
 *
 * となり、どちらも「新しい scope が使えない」症状だけが見えて原因が分かれる。
 * 「4 箇所を忘れず直す」を人間の注意力に頼る代わりに、TS 側の 1 つの定数を唯一の
 * 期待値として 4 箇所すべてへ突き合わせ、次に scope を触る人が漏らせないようにする。
 *
 * DB 側の期待値をこのファイルに literal で書かないのが要点。書くと「5 箇所目」が
 * 増えるだけで、同じ取りこぼしがここでも起きる。
 *
 * #2183 で DB 側の allowlist は `private.oauth_supported_scopes_v1()` の単一定義へ
 * 一元化した。CHECK 制約 3 本と grant 関数本体はもう scope literal を持たず、
 * この関数を参照するだけになったため、定義文から literal を正規表現で抜き出す
 * 突き合わせ（旧方式）はもう機能しない。代わりに (a) 単一定義の中身が
 * SUPPORTED_SCOPES と一致すること (b) 4 箇所すべてが単一定義を参照している
 * こと（= 自前の literal を持たないこと）の 2 点を確認する。
 */

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const productionResource = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

/** 置換前の scope。alias を残さず消したので、どの層でも復活していてはならない。 */
const REMOVED_SCOPE = 'read:tags';

const SCOPE_CHECK_CONSTRAINTS = [
  'oauth_connections_scope_set',
  'oauth_tokens_supported_scopes_check',
  'oauth_authorization_codes_supported_scopes_check',
] as const;

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `mcp-scope-allowlist-${userId}@example.com`;

function runOwnerSql(
  sql: string,
  variables: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      env: { ...process.env, PGPASSWORD: 'postgres' },
      encoding: 'utf8',
      input: `\\set VERBOSITY verbose\n${sql}`,
    },
  );
}

function expectRows(result: SpawnSyncReturns<string>): string[] {
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const output = result.stdout.trim();
  return output === '' ? [] : output.split('\n');
}

/**
 * 定義文（catalog から読んだテキスト）に scope literal が残っていないかを
 * JS 側で直接検査するパターン。scope は必ず `区分:対象` の形なので、コロンを
 * 含む引用文字列に絞れば `'S256'` のような無関係な文字列を巻き込まない。
 */
const SCOPE_LITERAL_PATTERN = /'[a-z]+:[a-z]+'/;

describe.skipIf(!RUN_LOCAL)('MCP OAuth scope allowlist', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (error) throw error;
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(userId);
  });

  it('単一定義 private.oauth_supported_scopes_v1() が SUPPORTED_SCOPES と完全一致する', () => {
    const rows = expectRows(
      runOwnerSql(`SELECT unnest(private.oauth_supported_scopes_v1()) ORDER BY 1;`),
    );

    expect(rows).toEqual([...SUPPORTED_SCOPES].sort());
    expect(rows).not.toContain(REMOVED_SCOPE);
  });

  it('CHECK 制約 3 本が単一定義を参照し、自前の scope literal を持たない', () => {
    for (const constraintName of SCOPE_CHECK_CONSTRAINTS) {
      // 定義は catalog から読む。migration ファイルの本文を読むと、後から別の
      // migration が制約を差し替えた時に古い定義を検証してしまう。
      const rows = expectRows(
        runOwnerSql(
          `
            SELECT pg_catalog.pg_get_constraintdef(c.oid)
            FROM pg_constraint AS c
            JOIN pg_class AS rel ON rel.oid = c.conrelid
            JOIN pg_namespace AS schema ON schema.oid = rel.relnamespace
            WHERE schema.nspname = 'public'
              AND c.conname = :'constraint_name';
          `,
          { constraint_name: constraintName },
        ),
      );

      expect(rows, constraintName).toHaveLength(1);
      expect(rows[0], constraintName).toContain('private.oauth_supported_scopes_v1()');
      expect(rows[0], constraintName).not.toMatch(SCOPE_LITERAL_PATTERN);
    }
  });

  it('grant 関数本体が単一定義を参照し、allowlist 判定に自前の scope literal を持たない', () => {
    // `p_scopes <@ ...` の中だけを見る。本体には write scope の配列や
    // read:entries 同伴チェックにも scope literal が出るので、body 全体から
    // 集めると無関係な literal を巻き込む。
    const rows = expectRows(
      runOwnerSql(`
        SELECT pg_catalog.substring(p.prosrc, 'p_scopes <@ [^\\n]*')
        FROM pg_proc AS p
        JOIN pg_namespace AS schema ON schema.oid = p.pronamespace
        WHERE schema.nspname = 'public'
          AND p.proname = 'create_oauth_authorization_grant_v2';
      `),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('private.oauth_supported_scopes_v1()');
    expect(rows[0]).not.toMatch(SCOPE_LITERAL_PATTERN);
  });

  it('grant 関数は SUPPORTED_SCOPES の read scope をすべて受け付ける', async () => {
    // catalog 一致だけでは「書いてあるが動く」ことを示せないので、実際に grant を
    // 作る。write scope は mcp_mutation_control の client gate に依存し、この
    // suite の関心（allowlist）から外れるので read scope だけを通す。
    const readScopes = SUPPORTED_SCOPES.filter((scope) => scope.startsWith('read:'));
    expect(readScopes.length).toBeGreaterThan(0);

    for (const scope of readScopes) {
      const code = `scope-allowlist-${crypto.randomUUID()}`;
      const { data: connectionId, error } = await admin.rpc('create_oauth_authorization_grant_v2', {
        p_user_id: userId,
        p_client_id: 'chatgpt',
        p_resource_uri: productionResource,
        p_scopes: [scope],
        p_code_hash: code,
        p_redirect_uri: redirectUri,
        p_code_challenge: 'scope-allowlist-challenge',
        p_write_enabled: false,
      });

      expect(error, scope).toBeNull();
      expect(connectionId, scope).toEqual(expect.any(String));

      // 関数は connections と authorization_codes の両方へ INSERT するので、
      // 行が実在することの確認が CHECK 制約 2 本を実際に通した証拠にもなる。
      const stored = expectRows(
        runOwnerSql(
          `
            SELECT
              (SELECT pg_catalog.array_to_string(scopes, ',')
                 FROM public.oauth_connections WHERE id = :'connection_id'::UUID)
              || '|' ||
              (SELECT pg_catalog.array_to_string(scopes, ',')
                 FROM public.oauth_authorization_codes WHERE code_hash = :'code_hash');
          `,
          { connection_id: String(connectionId), code_hash: code },
        ),
      );
      expect(stored, scope).toEqual([`${scope}|${scope}`]);
    }
  });

  it('grant 関数は SUPPORTED_SCOPES にない scope を 22023 で拒否する', async () => {
    for (const scope of [REMOVED_SCOPE, 'read:everything']) {
      const { error } = await admin.rpc('create_oauth_authorization_grant_v2', {
        p_user_id: userId,
        p_client_id: 'chatgpt',
        p_resource_uri: productionResource,
        p_scopes: [scope],
        p_code_hash: `scope-allowlist-rejected-${crypto.randomUUID()}`,
        p_redirect_uri: redirectUri,
        p_code_challenge: 'scope-allowlist-challenge',
        p_write_enabled: false,
      });

      // 22023 = invalid_parameter_value。関数が自分で投げるコードで、CHECK 制約の
      // 23514 とは別物。ここが 23514 になったら「関数側の allowlist が広すぎて
      // CHECK で受け止めている」状態なので、コードまで assert する。
      expect(error?.code, scope).toBe('22023');
    }
  });

  it('oauth_tokens の CHECK は SUPPORTED_SCOPES の scope を通し、外れた scope を弾く', async () => {
    // トークンは grant 関数を経由せず発行されるため、3 テーブルのうちここだけは
    // 関数経由の probe で覆えない。直接 INSERT で CHECK を叩く。
    const code = `scope-allowlist-token-${crypto.randomUUID()}`;
    const { data: connectionId, error } = await admin.rpc('create_oauth_authorization_grant_v2', {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: productionResource,
      p_scopes: ['read:entries'],
      p_code_hash: code,
      p_redirect_uri: redirectUri,
      p_code_challenge: 'scope-allowlist-challenge',
      p_write_enabled: false,
    });
    expect(error).toBeNull();

    const insertToken = (scope: string) =>
      runOwnerSql(
        `
          INSERT INTO public.oauth_tokens (
            user_id, token_hash, token_type, client_id, scopes,
            expires_at, connection_id, resource_uri
          ) VALUES (
            :'user_id'::UUID,
            'scope-allowlist-' || :'scope' || '-' || :'user_id',
            'access',
            'chatgpt',
            ARRAY[:'scope']::TEXT[],
            pg_catalog.now() + INTERVAL '5 minutes',
            :'connection_id'::UUID,
            :'resource_uri'
          );
        `,
        {
          user_id: userId,
          scope,
          connection_id: String(connectionId),
          resource_uri: productionResource,
        },
      );

    for (const scope of SUPPORTED_SCOPES) {
      // write scope 単独は write_requires_read_entries_check（別の制約）で落ちるので、
      // ここでは read:entries を必ず同伴させる形にはせず、read scope だけを通す。
      if (!scope.startsWith('read:')) continue;
      const accepted = insertToken(scope);
      expect(accepted.status, scope).toBe(0);
    }

    const rejected = insertToken(REMOVED_SCOPE);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('23514');
    expect(rejected.stderr).toContain('oauth_tokens_supported_scopes_check');
  });

  it('service_role は oauth_tokens / oauth_connections の last_used_at を直接 UPDATE できる', async () => {
    // `apps/product/src/lib/mcp/auth.ts` の `updateUsageTimestamps()` が
    // service_role で直接 UPDATE する経路（RPC を経由しない）。CHECK 制約は
    // UPDATE のたびに全カラム再評価され、制約式内の関数呼び出しは実行中の
    // ロール（ここでは service_role）で EXECUTE 権限をチェックされるため、
    // `private.oauth_supported_scopes_v1()` への GRANT が抜けると
    // 42501（permission denied for function）でこの経路だけが壊れる
    // （risk-reviewer の反証レビューで検出、20260820100001 で修正）。
    // owner（postgres）や SECURITY DEFINER 経由の呼び出しは owner 権限で
    // 素通りしてしまい検出できないため、`admin`（service_role client）で
    // 直接 UPDATE することが重要。
    const code = `scope-allowlist-usage-${crypto.randomUUID()}`;
    const { data: connectionId, error } = await admin.rpc('create_oauth_authorization_grant_v2', {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: productionResource,
      p_scopes: ['read:entries'],
      p_code_hash: code,
      p_redirect_uri: redirectUri,
      p_code_challenge: 'scope-allowlist-usage-challenge',
      p_write_enabled: false,
    });
    expect(error).toBeNull();

    const tokenHash = `scope-allowlist-usage-token-${crypto.randomUUID()}`;
    const insertResult = runOwnerSql(
      `
        INSERT INTO public.oauth_tokens (
          user_id, token_hash, token_type, client_id, scopes,
          expires_at, connection_id, resource_uri
        ) VALUES (
          :'user_id'::UUID,
          :'token_hash',
          'access',
          'chatgpt',
          ARRAY['read:entries']::TEXT[],
          pg_catalog.now() + INTERVAL '5 minutes',
          :'connection_id'::UUID,
          :'resource_uri'
        );
      `,
      {
        user_id: userId,
        token_hash: tokenHash,
        connection_id: String(connectionId),
        resource_uri: productionResource,
      },
    );
    expect(insertResult.status).toBe(0);

    const { error: tokenUpdateError } = await admin
      .from('oauth_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('token_hash', tokenHash);
    expect(tokenUpdateError).toBeNull();

    const { error: connectionUpdateError } = await admin
      .from('oauth_connections')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', String(connectionId));
    expect(connectionUpdateError).toBeNull();
  });
});
