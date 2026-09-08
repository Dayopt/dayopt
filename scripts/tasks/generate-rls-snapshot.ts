#!/usr/bin/env node

/**
 * RLS / schema snapshot 生成スクリプト（I-16）
 *
 * 「現在有効な RLS ポリシー / GRANT / Realtime publication」を migration を全部読まずに
 * 把握できるよう、DB の pg_policies / RLS 有効状態 / 権限 / publication を
 * 1 コマンドで deterministic な markdown に書き出す。
 * `api:spec` と同型で、--check で CI ドリフト検出を行う。
 *
 * 入力 DB:
 *   DATABASE_URL（無ければ local Supabase の既定接続先）
 *   migration から構築された DB を読むため、「migration が定義する RLS」を反映する。
 *
 * Usage:
 *   pnpm rls:snapshot          # docs を生成/更新
 *   pnpm rls:snapshot:check    # 既存 snapshot と比較（CI 用ドリフト検出。差分で exit 1）
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { format as formatWithPrettier } from 'prettier';

import { escapeMarkdownTableCell as cell } from '../lib/markdown-table';
import {
  STORAGE_OBJECTS_APP_POLICY_NAMES,
  sqlStringList,
} from '../lib/storage-objects-app-policy-names.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUTPUT_PATH = resolve(ROOT, 'docs/engineering/data/db/rls-snapshot.md');
const CHECK_MODE = process.argv.includes('--check');
const LOCAL_SUPABASE_DATABASE_URL = [
  'postgresql://postgres',
  ':',
  'postgres',
  '@127.0.0.1:54322/postgres',
].join('');
const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_SUPABASE_DATABASE_URL;

/**
 * GRANT OPTION 付きの権限を `*` 付きで出す（psql の `\dp` と同じ表記）。
 * aclexplode() の is_grantable を捨てると、既存 GRANT を WITH GRANT OPTION 付きへ変えても
 * snapshot が同一のままになり、付与された側が第三者へ再付与できる状態が drift 検出を
 * すり抜ける。public / private のすべての ACL クエリで同じ式を使う。
 *
 * 集約は DISTINCT + 同じ式での ORDER BY にする。aclitem は (grantee, grantor) 単位なので、
 * 同じ grantee が同じ権限を別の grantor から受けていると 1 grantee に複数行が返り、
 * privilege_type だけの ORDER BY では並びが不定になる（現状は grantor 1 種のみで発火しない）。
 */
const GRANTABLE_PRIVILEGE_SQL =
  "acl.privilege_type || CASE WHEN acl.is_grantable THEN '*' ELSE '' END";

/**
 * `STORAGE_OBJECTS_APP_POLICY_NAMES`（allow-list）と `sqlStringList` は
 * `./lib/storage-objects-app-policy-names.mjs` が単一の正本（#2323。production 側の
 * drift 検出スクリプトと共有するため抽出した。詳細な rationale は同ファイル参照）。
 *
 * リスト外の policy 名が現れた場合は `fetchUnexpectedStoragePolicyNames()` が
 * 別枠で拾い、0 件を機械固定する（allow-list が古くなって新しい policy を静かに
 * 見逃す事態を防ぐ）。名前を変えずに USING / WITH CHECK 句だけを変更した場合は、
 * 配列に触れなくても内容差分として drift 検出される。
 */

/**
 * 「本物の custom type / domain」だけを `pg_type` から拾うための絞り込み条件（#1900）。
 * psql `\dT`（list of user-visible data types）と同じ判定式で、以下を除外する:
 * - implicit array type（あらゆる型に自動生成される `_型名`。typelem/typarray の自己参照で判定）
 * - implicit row type（CREATE TABLE / VIEW のたびに自動生成される複合型。typrelid が指す
 *   pg_class の relkind が 'c'（複合型そのもの）でなければテーブル等の row type と判定）
 *
 * 除外しないと、`acldefault('T', owner)` は implicit type にも PUBLIC USAGE を既定付与するため、
 * private の全 table が「PUBLIC が USAGE を持つ」行を毎回生成し、0 件の基準線が意味をなさなくなる
 * （ローカル DB で実測: private の 23 table 分・46 件の implicit type が該当し、フィルタなしでは
 * 「0 件」の主張が成立しない）。
 */
const PRIVATE_CUSTOM_TYPE_WHERE_SQL = `(ty.typrelid = 0 OR EXISTS (
             SELECT 1 FROM pg_class c2 WHERE c2.oid = ty.typrelid AND c2.relkind = 'c'
           ))
           AND NOT EXISTS (
             SELECT 1 FROM pg_type el WHERE el.oid = ty.typelem AND el.typarray = ty.oid
           )`;

type PolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string;
  permissive: string;
  roles: string;
  using_expr: string;
  check_expr: string;
};

type RlsRow = { table: string; rls: boolean; forced: boolean };

type TableWithoutRlsProtectionRow = { table_name: string; rls: boolean; policy_count: number };

type StorageBucketRow = {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string;
};
type GrantRow = { object_type: string; object_name: string; grantee: string; privileges: string };
/** private schema の GRANT（オブジェクト ACL / function EXECUTE）は owner 以外の grantee だけを機械固定する */
type PrivateGrantRow = { object_name: string; grantee: string; privileges: string };
type PrivateColumnGrantRow = PrivateGrantRow & { column_name: string };
type SchemaGrantRow = { grantee: string; privileges: string };
type PrivateOwnerRow = { target: string; object_name: string; owner: string };
type RealtimePublicationRow = { schemaname: string; tablename: string };
type EffectiveTimeblockWritePrivilegeRow = {
  object_type: string;
  grantee: string;
  object_name: string;
  privilege_type: string;
};
type PublicContractExposureRow = {
  violation_kind: string;
  object_type: string;
  object_name: string;
  detail: string;
};

/** psql で 1 行 JSON を取り出す（複数行・特殊文字に強い） */
function queryJson<T>(sql: string): T {
  const out = execFileSync('psql', [DATABASE_URL, '-t', '-A', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return JSON.parse(out || 'null') as T;
}

function fetchPolicies(): PolicyRow[] {
  return (
    queryJson<PolicyRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.tablename, t.cmd, t.policyname), '[]'::json)
       FROM (
         SELECT tablename, policyname, cmd, permissive, roles::text AS roles,
                coalesce(qual, '') AS using_expr, coalesce(with_check, '') AS check_expr
         FROM pg_policies WHERE schemaname = 'public'
       ) t;`,
    ) ?? []
  );
}

function fetchRlsTables(): RlsRow[] {
  return (
    queryJson<RlsRow[] | null>(
      `SELECT coalesce(json_agg(json_build_object(
                'table', c.relname, 'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity
              ) ORDER BY c.relname), '[]'::json)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r';`,
    ) ?? []
  );
}

/**
 * RLS を有効化しつつ policy を 1 件も置かない「deny-all」設計を意図的に使っている
 * public table の allow-list（#2596 CODEX-1 の決定的代替）。
 *
 * `RLS enabled + policy 0 件` は anon / authenticated からの読み書きを完全に拒否する
 * 意図的なパターンで、MCP 系の内部テーブル（service role からしか触らない）で使われている。
 * これを一律で red にすると既存の正当な設計を壊すため、名前を明示した allow-list だけを
 * 通す。新設テーブルがここに載っていない状態で `rls=false` または `policy 0 件` になった
 * 場合は、テナント分離が抜けている可能性が高いとみなし fail closed にする（新たに
 * deny-all を選ぶ場合は、このリストへ明示的に追加することでレビューに乗る）。
 */
const PUBLIC_TABLES_WITHOUT_POLICIES_ALLOWLIST = [
  'mcp_environment_identity',
  'mcp_mutation_control',
  'mcp_mutation_receipts',
  // #2618: MFA リカバリコードは「MFA を解除してよいか」の判断根拠なので、判断される当人
  // （anon / authenticated）から到達させない。grant を revoke したうえで policy も落とし、
  // service_role の SECURITY DEFINER RPC（生成 = replace_mfa_recovery_codes_v1、
  // 消費 = use_recovery_code、件数 = count_unused_recovery_codes）だけを入口にしている。
  // 「policy が無い」のは分離の抜けではなく、分離を policy より下の層（grant）で行った結果。
  'mfa_recovery_codes',
];

/**
 * テナント分離の穴を DB 側から実測する（#2596）。Codex クロスレビューが人手で見ていた
 * 「新設 table に RLS policy が無い」を決定的検査へ置き換える。
 *
 * `rls = false`（RLS 自体を有効化し忘れている）と、`policy 0 件`（RLS は有効だが
 * allow-list に無い deny-all）の両方を対象にする。1 行でも返れば snapshot 生成を停止する。
 */
function fetchTablesWithoutRlsProtection(): TableWithoutRlsProtectionRow[] {
  return (
    queryJson<TableWithoutRlsProtectionRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(v) ORDER BY v.table_name), '[]'::json)
       FROM (
         SELECT c.relname AS table_name, c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname NOT IN (${sqlStringList(PUBLIC_TABLES_WITHOUT_POLICIES_ALLOWLIST)})
           AND (
             c.relrowsecurity = false
             OR (SELECT count(*) FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname) = 0
           )
       ) v;`,
    ) ?? []
  );
}

/** app 所有と確認済みの `storage.objects` policy（allow-list 内）だけを public 相当の粒度で取得する */
function fetchStoragePolicies(): PolicyRow[] {
  return (
    queryJson<PolicyRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.cmd, t.policyname), '[]'::json)
       FROM (
         SELECT tablename, policyname, cmd, permissive, roles::text AS roles,
                coalesce(qual, '') AS using_expr, coalesce(with_check, '') AS check_expr
         FROM pg_policies
         WHERE schemaname = 'storage' AND tablename = 'objects'
           AND policyname IN (${sqlStringList(STORAGE_OBJECTS_APP_POLICY_NAMES)})
       ) t;`,
    ) ?? []
  );
}

/**
 * allow-list に無い `storage.objects` policy 名を検出する。0 件を機械固定することで、
 * allow-list の更新漏れ（新しい policy が静かに snapshot から漏れる事態）を drift として拾う。
 */
function fetchUnexpectedStoragePolicyNames(): string[] {
  return (
    queryJson<string[] | null>(
      `SELECT coalesce(json_agg(policyname ORDER BY policyname), '[]'::json)
       FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname NOT IN (${sqlStringList(STORAGE_OBJECTS_APP_POLICY_NAMES)});`,
    ) ?? []
  );
}

/**
 * `storage.objects` の RLS 有効状態。policy の内容だけでなく「RLS 自体が外れていないか」も
 * public テーブルと同じ重みで見る（policy は残っていても ENABLE ROW LEVEL SECURITY が
 * 外れれば無力化されるため、policy 一覧だけでは検出できない）。
 */
function fetchStorageObjectsRls(): RlsRow[] {
  return (
    queryJson<RlsRow[] | null>(
      `SELECT coalesce(json_agg(json_build_object(
                'table', n.nspname || '.' || c.relname,
                'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity
              )), '[]'::json)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'storage' AND c.relname = 'objects' AND c.relkind = 'r';`,
    ) ?? []
  );
}

/**
 * bucket の公開フラグと受け入れ制限（#1900 の risk-reviewer 指摘）。
 *
 * **policy より先にこちらが到達可否を決める。** `storage.buckets.public = true` の bucket は
 * read が object の RLS policy を経由しない（このリポジトリ自身が 20260401000000 で
 * getPublicUrl 整合のため avatars を public 化しているのが一次証拠）。
 * つまり `UPDATE storage.buckets SET public = true WHERE id = 'attachments'` の 1 行で
 * 全ユーザーの添付が未認証公開になるが、policy だけを追跡していると snapshot に差分が出ない。
 * policy を追跡して「storage 境界は pin 済み」と読ませる以上、この行を見ないのは誤導なので
 * 同じ節で固定する。
 *
 * file_size_limit / allowed_mime_types も、緩めると受け入れる内容が変わる境界なので併せて固定する。
 * いずれも migration と config.toml 由来の決定的なローカル状態。
 */
function fetchStorageBuckets(): StorageBucketRow[] {
  return (
    queryJson<StorageBucketRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)
       FROM (
         SELECT id, public, file_size_limit,
                coalesce(array_to_string(allowed_mime_types, ', '), '') AS allowed_mime_types
         FROM storage.buckets
       ) t;`,
    ) ?? []
  );
}

function fetchGrants(): GrantRow[] {
  return (
    queryJson<GrantRow[] | null>(
      `WITH relation_grants AS (
         SELECT
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'p' THEN 'table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized view'
             ELSE c.relkind::text
           END AS object_type,
           n.nspname || '.' || c.relname AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) acl
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm')
           AND (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END)
             IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
         GROUP BY object_type, object_name, grantee
       ),
       column_grants AS (
         SELECT
           'column' AS object_type,
           n.nspname || '.' || c.relname || '.' || a.attname AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(a.attacl) acl
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm')
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END)
             IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
         GROUP BY object_type, object_name, grantee
       ),
       routine_grants AS (
         SELECT
           'routine' AS object_type,
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         WHERE n.nspname = 'public'
           AND (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END)
             IN ('PUBLIC', 'anon', 'authenticated', 'service_role', 'supabase_auth_admin')
           AND acl.privilege_type = 'EXECUTE'
         GROUP BY object_type, object_name, grantee
       )
       SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.object_type, t.object_name, t.grantee), '[]'::json)
       FROM (
         SELECT * FROM column_grants
         UNION ALL
         SELECT * FROM relation_grants
         UNION ALL
         SELECT * FROM routine_grants
       ) t;`,
    ) ?? []
  );
}

/**
 * private schema は PostgREST に公開されないため、public 向け fetchGrants() のような
 * role allow-list（anon/authenticated/service_role 等）は使わない。owner（table/function/
 * schema の所有者、local では `postgres`）が持つ権限は既定でノイズになるので除外し、
 * 「owner 以外の grantee が持つ権限」だけを機械固定する。
 */
function fetchPrivateRelationGrants(): GrantRow[] {
  return (
    queryJson<GrantRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.object_name, t.grantee), '[]'::json)
       FROM (
         SELECT
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'p' THEN 'partitioned table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized view'
             WHEN 'S' THEN 'sequence'
             WHEN 'f' THEN 'foreign table'
           END AS object_type,
           n.nspname || '.' || c.relname AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) acl
         WHERE n.nspname = 'private'
           -- ACL を持ちうる relkind を網羅する。sequence('S') を落とすと
           -- GRANT USAGE ON SEQUENCE が drift 検出をすり抜ける（private に sequence は実在する）。
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND acl.grantee <> c.relowner
         GROUP BY object_type, object_name, grantee
       ) t;`,
    ) ?? []
  );
}

/**
 * 列レベル ACL（`pg_attribute.attacl`）は table ACL が空でも独立に成立する。public 側では
 * calendar_connections の秘匿列で実際に使っている pattern なので、private でも 0 件を機械固定して
 * おかないと `GRANT SELECT (col) ON private.t TO ...` が drift 検出をすり抜ける。
 */
/**
 * owner を ACL 一覧から除外する以上、その owner が誰かを記録しないと除外の範囲が無制限になる。
 * ownership は ACL の外側にあり REVOKE で剥がせないため、owner が低信頼ロールへ変わると
 * 「grant 0 件のまま実質フルアクセス」という状態が CI green のまま成立してしまう。
 * owner 名を assert すると環境差（local と production）で壊れるので、assert ではなく
 * 記録する。owner が変われば snapshot が変化し、drift として検出される。
 *
 * ロール別の件数に集約すると、件数の変わらない所有権移動（機密オブジェクトと無害な
 * オブジェクトの owner を入れ替える等）を検出できない。オブジェクト単位で記録する。
 */
function fetchPrivateOwners(): PrivateOwnerRow[] {
  return (
    queryJson<PrivateOwnerRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.target, t.object_name), '[]'::json)
       FROM (
         -- 各 branch の object_name を text へ明示キャストする。先頭 branch の nspname は
         -- name 型（63 byte）で、UNION の型がそちらに寄ると関数の identity arguments が
         -- 途中で切れる。切断位置より後だけが異なる overload 間で owner を入れ替えても
         -- 行集合が変わらず、所有権 drift の検出をすり抜ける。
         SELECT 'schema' AS target, n.nspname::text AS object_name, pg_get_userbyid(n.nspowner) AS owner
         FROM pg_namespace n
         WHERE n.nspname = 'private'
         UNION ALL
         SELECT 'object', (n.nspname || '.' || c.relname)::text, pg_get_userbyid(c.relowner)
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'private'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         UNION ALL
         SELECT 'function',
                (n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text,
                pg_get_userbyid(p.proowner)
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'private'
         UNION ALL
         -- custom type / domain（implicit row/array type は除外。fetchPrivateTypeGrants() と同じ判定）
         SELECT 'type', (n.nspname || '.' || ty.typname)::text, pg_get_userbyid(ty.typowner)
         FROM pg_type ty
         JOIN pg_namespace n ON n.oid = ty.typnamespace
         WHERE n.nspname = 'private'
           AND ${PRIVATE_CUSTOM_TYPE_WHERE_SQL}
       ) t;`,
    ) ?? []
  );
}

function fetchPrivateColumnGrants(): PrivateColumnGrantRow[] {
  return (
    queryJson<PrivateColumnGrantRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.object_name, t.column_name, t.grantee), '[]'::json)
       FROM (
         SELECT
           n.nspname || '.' || c.relname AS object_name,
           a.attname AS column_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(a.attacl) acl
         WHERE n.nspname = 'private'
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND acl.grantee <> c.relowner
         GROUP BY object_name, column_name, grantee
       ) t;`,
    ) ?? []
  );
}

function fetchPrivateRoutineGrants(): PrivateGrantRow[] {
  return (
    queryJson<PrivateGrantRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.object_name, t.grantee), '[]'::json)
       FROM (
         SELECT
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         -- proacl が NULL（明示 grant/revoke 未実施）だと Postgres の既定 ACL は PUBLIC に
         -- EXECUTE を与える。acldefault で明示化してから aclexplode しないとその既定 EXECUTE を
         -- 見落とす（既存 public 向け routine_grants と同じ理由）。
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         WHERE n.nspname = 'private'
           AND acl.privilege_type = 'EXECUTE'
           AND acl.grantee <> p.proowner
         GROUP BY object_name, grantee
       ) t;`,
    ) ?? []
  );
}

/**
 * private schema の custom type / domain の USAGE ACL（`pg_type.typacl`）。function の EXECUTE と
 * 同じく Postgres は既定で PUBLIC に USAGE を付与するクラスなので、`proacl` と同型で
 * `coalesce(t.typacl, acldefault('T', t.typowner))` により既定 ACL を明示化してから explode する
 * （fetchPrivateRoutineGrants() と同型。#1900）。
 *
 * implicit array type / implicit row type は PRIVATE_CUSTOM_TYPE_WHERE_SQL で除外する。
 * 除外しないと CREATE TABLE のたびに自動生成される型が「PUBLIC が USAGE を持つ」行を
 * 生成し続け、0 件の基準線が意味をなさなくなる。
 */
function fetchPrivateTypeGrants(): PrivateGrantRow[] {
  return (
    queryJson<PrivateGrantRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.object_name, t.grantee), '[]'::json)
       FROM (
         SELECT
           n.nspname || '.' || ty.typname AS object_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_type ty
         JOIN pg_namespace n ON n.oid = ty.typnamespace
         CROSS JOIN LATERAL aclexplode(coalesce(ty.typacl, acldefault('T', ty.typowner))) acl
         WHERE n.nspname = 'private'
           AND ${PRIVATE_CUSTOM_TYPE_WHERE_SQL}
           AND acl.grantee <> ty.typowner
         GROUP BY object_name, grantee
       ) t;`,
    ) ?? []
  );
}

function fetchPrivateSchemaUsage(): SchemaGrantRow[] {
  return (
    queryJson<SchemaGrantRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.grantee), '[]'::json)
       FROM (
         SELECT
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
           string_agg(DISTINCT ${GRANTABLE_PRIVILEGE_SQL}, ', ' ORDER BY ${GRANTABLE_PRIVILEGE_SQL}) AS privileges
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) acl
         WHERE n.nspname = 'private'
           AND acl.grantee <> n.nspowner
         GROUP BY grantee
       ) t;`,
    ) ?? []
  );
}

function fetchRealtimePublication(): RealtimePublicationRow[] {
  return (
    queryJson<RealtimePublicationRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.schemaname, t.tablename), '[]'::json)
       FROM (
         SELECT schemaname, tablename
         FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
       ) t;`,
    ) ?? []
  );
}

/**
 * Plan / Record の effective write 境界（`anon` / `authenticated`）を DB 側の
 * canonical audit view から読む。1 行でも返れば Candidate 6 の cutover が崩れている。
 */
function fetchEffectiveTimeblockWritePrivileges(): EffectiveTimeblockWritePrivilegeRow[] {
  return (
    queryJson<EffectiveTimeblockWritePrivilegeRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(violation) ORDER BY
                violation.grantee,
                violation.object_type,
                violation.object_name,
                violation.privilege_type
              ), '[]'::json)
       FROM private.timeblock_effective_write_privileges_v1 AS violation;`,
    ) ?? []
  );
}

/**
 * `public` schema の契約露出（#2433）を DB 側の canonical audit view から読む。
 *
 * `security_invoker` は **reloption であって ACL ではない**ため、この file の GRANT 一覧
 * には現れない。GRANT だけを snapshot していると「definer 権限で他人の行を返す view」が
 * drift 検出をすり抜けるので、専用の section を持つ。1 行でも返れば snapshot 生成を止める。
 */
function fetchPublicContractExposure(): PublicContractExposureRow[] {
  return (
    queryJson<PublicContractExposureRow[] | null>(
      `SELECT coalesce(json_agg(row_to_json(violation) ORDER BY
                violation.violation_kind,
                violation.object_name,
                violation.detail
              ), '[]'::json)
       FROM private.public_contract_exposure_v1 AS violation;`,
    ) ?? []
  );
}

/**
 * render() の入力。**位置引数ではなく名前付きで渡す**。
 * 同じ型の section が複数あるため（public / storage の PolicyRow[]・RlsRow[]、
 * function / custom type の PrivateGrantRow[]、public / private の GrantRow[]）、
 * 位置引数だと取り違えても型検査を通ってしまい、「public の policy が storage の見出しで
 * 描画された snapshot」が drift 無しとして通る。security artifact でこれは致命的なので、
 * section を足す時も必ずこの型へフィールドとして足す。
 */
type SnapshotSections = {
  policies: PolicyRow[];
  rlsTables: RlsRow[];
  storagePolicies: PolicyRow[];
  storageObjectsRls: RlsRow[];
  storageBuckets: StorageBucketRow[];
  unexpectedStoragePolicyNames: string[];
  grants: GrantRow[];
  privateOwners: PrivateOwnerRow[];
  privateRelationGrants: GrantRow[];
  privateColumnGrants: PrivateColumnGrantRow[];
  privateRoutineGrants: PrivateGrantRow[];
  privateTypeGrants: PrivateGrantRow[];
  privateSchemaUsage: SchemaGrantRow[];
  realtimePublication: RealtimePublicationRow[];
  effectiveTimeblockWritePrivileges: EffectiveTimeblockWritePrivilegeRow[];
  publicContractExposure: PublicContractExposureRow[];
};

function render({
  policies,
  rlsTables,
  storagePolicies,
  storageObjectsRls,
  storageBuckets,
  unexpectedStoragePolicyNames,
  grants,
  privateOwners,
  privateRelationGrants,
  privateColumnGrants,
  privateRoutineGrants,
  privateTypeGrants,
  privateSchemaUsage,
  realtimePublication,
  effectiveTimeblockWritePrivileges,
  publicContractExposure,
}: SnapshotSections): string {
  const policyByTable = new Map<string, PolicyRow[]>();
  for (const p of policies) {
    const list = policyByTable.get(p.tablename) ?? [];
    list.push(p);
    policyByTable.set(p.tablename, list);
  }

  const lines: string[] = [];
  lines.push('# RLS / schema snapshot（自動生成）');
  lines.push('');
  lines.push(
    '> **生成元**: `scripts/tasks/generate-rls-snapshot.ts`（`pnpm rls:snapshot`）。DB の `pg_policies` /',
  );
  lines.push(
    '> RLS 有効状態 / GRANT / Realtime publication を deterministic に書き出した snapshot。',
  );
  lines.push(
    '> **手で編集しない**。migration 変更時は CI（`pnpm rls:snapshot:check`）が drift を検出する。',
  );
  lines.push('> 再生成で更新すること。');
  lines.push('>');
  lines.push(
    `> 集計: public スキーマの policy ${policies.length} 件 / RLS 対象テーブル ${rlsTables.length} 件 / GRANT ${grants.length} 件 /` +
      ` storage.objects の policy（app 所有）${storagePolicies.length} 件 / 想定外 policy ${unexpectedStoragePolicyNames.length} 件 /` +
      ` private schema のオブジェクト ACL（owner 以外）${privateRelationGrants.length} 件 / 列レベル ACL（owner 以外）${privateColumnGrants.length} 件 / function EXECUTE（owner 以外）${privateRoutineGrants.length} 件 / custom type USAGE（owner 以外）${privateTypeGrants.length} 件 / schema USAGE（owner 以外）${privateSchemaUsage.length} 件 /` +
      ` Realtime publication ${realtimePublication.length} 件。`,
  );
  lines.push('');

  lines.push('## RLS 有効状態（public テーブル）');
  lines.push('');
  lines.push('| table | RLS enabled | forced |');
  lines.push('| --- | --- | --- |');
  for (const r of rlsTables) {
    lines.push(`| ${r.table} | ${r.rls ? '✅' : '❌'} | ${r.forced ? '✅' : '—'} |`);
  }
  lines.push('');

  lines.push('## ポリシー一覧（table 別）');
  lines.push('');
  for (const table of [...policyByTable.keys()].sort()) {
    lines.push(`### ${table}`);
    lines.push('');
    lines.push('| policy | cmd | permissive | roles | USING | WITH CHECK |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const p of policyByTable.get(table) ?? []) {
      lines.push(
        `| ${cell(p.policyname)} | ${p.cmd} | ${p.permissive} | ${cell(p.roles)} | ${cell(p.using_expr)} | ${cell(p.check_expr)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## storage.objects ポリシー一覧（app 所有）');
  lines.push('');
  lines.push(
    '`storage` schema は Supabase platform 自身も所有し、バージョンアップで内容が変わりうる',
  );
  lines.push(
    '（buckets_analytics / buckets_vectors / iceberg_namespaces / iceberg_tables / vector_indexes は',
  );
  lines.push(
    'このリポジトリの migration に一度も登場しない platform 専有 table）。schema 丸ごとの snapshot は',
  );
  lines.push(
    'platform 更新のたびに drift ノイズを生むため対象外にし、avatars / attachments のフォルダ所有権を',
  );
  lines.push(
    '判定する `storage.objects` の policy だけを、migration が定義した名前の allow-list で public',
  );
  lines.push('schema の policy と同じ重みで追跡する。あわせて bucket の公開フラグも固定する —');
  lines.push(
    '`public = true` の bucket は read が object の RLS を経由しないため、policy だけを見ていると',
  );
  lines.push('`UPDATE storage.buckets SET public = true` の 1 行が無検出で通ってしまう。');
  lines.push('');
  lines.push('**対象外**（この節が見ていないもの）:');
  lines.push('');
  lines.push(
    '- **table-level GRANT** — `storage.objects` への `anon` / `authenticated` の GRANT は Supabase',
  );
  lines.push(
    '  Storage 拡張が自ら付与する platform 既定値で、SELECT / INSERT / UPDATE / DELETE は RLS policy が',
  );
  lines.push(
    '  実効の門番になる。ただし **TRUNCATE は RLS の対象外**なので policy では止まらない（#1715 と同クラス）',
  );
  lines.push(
    '- **`storage.objects` 以外の table の policy**（`buckets` / `prefixes` 等）と、`authorize_owned_storage_*`',
  );
  lines.push('  関数の本体（ACL は追跡するが `prosrc` は見ない）');
  lines.push('');
  lines.push('| table | RLS enabled | forced |');
  lines.push('| --- | --- | --- |');
  for (const r of storageObjectsRls) {
    lines.push(`| ${cell(r.table)} | ${r.rls ? '✅' : '❌'} | ${r.forced ? '✅' : '—'} |`);
  }
  lines.push('');
  lines.push('| bucket | public | file size limit | allowed mime types |');
  lines.push('| --- | --- | --- | --- |');
  for (const b of storageBuckets) {
    lines.push(
      `| ${cell(b.id)} | ${b.public ? '⚠️ true' : 'false'} | ${b.file_size_limit ?? '—'} | ${cell(b.allowed_mime_types || '—')} |`,
    );
  }
  lines.push('');
  lines.push('| policy | cmd | permissive | roles | USING | WITH CHECK |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const p of storagePolicies) {
    lines.push(
      `| ${cell(p.policyname)} | ${p.cmd} | ${p.permissive} | ${cell(p.roles)} | ${cell(p.using_expr)} | ${cell(p.check_expr)} |`,
    );
  }
  lines.push('');
  lines.push('### 想定外の storage.objects policy（allow-list 外）');
  lines.push('');
  lines.push('allow-list 外の policy を検出した場合、`pnpm rls:snapshot` は snapshot を生成せず');
  lines.push('エラーで停止する（再生成による追認を防ぐため）。したがってこの節は常に 0 件で、');
  lines.push('0 件でない snapshot は存在しない。正当な追加なら');
  lines.push('`STORAGE_OBJECTS_APP_POLICY_NAMES` を更新してから再生成する。');
  lines.push('');
  if (unexpectedStoragePolicyNames.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    for (const name of unexpectedStoragePolicyNames) {
      lines.push(`- ${cell(name)}`);
    }
  }
  lines.push('');

  lines.push('## GRANT 一覧（public schema）');
  lines.push('');
  lines.push('| object type | object | grantee | privileges |');
  lines.push('| --- | --- | --- | --- |');
  for (const grant of grants) {
    lines.push(
      `| ${grant.object_type} | ${cell(grant.object_name)} | ${cell(grant.grantee)} | ${cell(grant.privileges)} |`,
    );
  }
  lines.push('');

  lines.push('## GRANT 一覧（private schema、owner 以外）');
  lines.push('');
  lines.push(
    '`private` schema は PostgREST に公開されない。owner（table / function / schema の所有者。',
  );
  lines.push('下表を参照）が持つ権限は既定でノイズになるため対象外にし、owner 以外の grantee に');
  lines.push(
    '付いている権限だけを機械固定する。「なし（0 件）」はその区分の grant が無いことを表す。',
  );
  lines.push('privileges 列の `*` は WITH GRANT OPTION 付き（psql の `\\dp` と同じ表記）。');
  lines.push('');
  lines.push(
    '**この snapshot が保証するのは「migration を素の DB に当てた結果」であって production の実 state',
  );
  lines.push(
    'ではない。** 生成元は migration から構築した local DB で、CI の drift check も同じく ephemeral な',
  );
  lines.push(
    'local DB に対してのみ走る。production に対する同等のチェックは存在しないため、production で',
  );
  lines.push('migration を経由しない手動変更が行われた場合、その差分はここに現れない。');
  lines.push('');
  lines.push(
    '対象は schema USAGE（`nspacl`）/ オブジェクト ACL（`relacl`）/ 列レベル ACL（`attacl`）/',
  );
  lines.push(
    'function EXECUTE（`proacl`）/ custom type・domain USAGE（`typacl`）の 5 catalog。次の 1 つは対象外:',
  );
  lines.push('');
  lines.push(
    '- **default privileges（`pg_default_acl`）** — local と production で非対称なことが分かっており、',
  );
  lines.push('  扱いは #1715 が決める（現時点で private の default ACL は 0 件）');
  lines.push('');

  lines.push('### private の owner（ACL 一覧から除外している主体）');
  lines.push('');
  lines.push('| 対象 | 名前 | owner |');
  lines.push('| --- | --- | --- |');
  for (const row of privateOwners) {
    lines.push(`| ${cell(row.target)} | ${cell(row.object_name)} | ${cell(row.owner)} |`);
  }
  lines.push('');

  lines.push('### private オブジェクト ACL（owner 以外）');
  lines.push('');
  if (privateRelationGrants.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    lines.push('| object_type | object | grantee | privileges |');
    lines.push('| --- | --- | --- | --- |');
    for (const grant of privateRelationGrants) {
      lines.push(
        `| ${cell(grant.object_type)} | ${cell(grant.object_name)} | ${cell(grant.grantee)} | ${cell(grant.privileges)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### private 列レベル ACL（owner 以外）');
  lines.push('');
  if (privateColumnGrants.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    lines.push('| object | column | grantee | privileges |');
    lines.push('| --- | --- | --- | --- |');
    for (const grant of privateColumnGrants) {
      lines.push(
        `| ${cell(grant.object_name)} | ${cell(grant.column_name)} | ${cell(grant.grantee)} | ${cell(grant.privileges)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### private function EXECUTE（owner 以外）');
  lines.push('');
  if (privateRoutineGrants.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    lines.push('| function | grantee | privileges |');
    lines.push('| --- | --- | --- |');
    for (const grant of privateRoutineGrants) {
      lines.push(
        `| ${cell(grant.object_name)} | ${cell(grant.grantee)} | ${cell(grant.privileges)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### private custom type / domain USAGE（owner 以外）');
  lines.push('');
  lines.push(
    'implicit array type（`_型名`）と implicit row type（table / view の自動生成複合型）は',
  );
  lines.push(
    '対象外（psql `\\dT` と同じ判定）。除外しないと private の全 table が「PUBLIC が USAGE を',
  );
  lines.push('持つ」行を生成し、0 件の基準線が意味をなさなくなる。');
  lines.push('');
  if (privateTypeGrants.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    lines.push('| type | grantee | privileges |');
    lines.push('| --- | --- | --- |');
    for (const grant of privateTypeGrants) {
      lines.push(
        `| ${cell(grant.object_name)} | ${cell(grant.grantee)} | ${cell(grant.privileges)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### private schema USAGE（owner 以外）');
  lines.push('');
  if (privateSchemaUsage.length === 0) {
    lines.push('- なし（0 件）');
  } else {
    lines.push('| grantee | privileges |');
    lines.push('| --- | --- |');
    for (const row of privateSchemaUsage) {
      lines.push(`| ${cell(row.grantee)} | ${cell(row.privileges)} |`);
    }
  }
  lines.push('');

  lines.push('## Plan / Record effective write境界');
  lines.push('');
  lines.push(
    effectiveTimeblockWritePrivileges.length === 0
      ? '- ✅ `anon` / `authenticated`のeffective table / column write権限なし'
      : '- ❌ effective write権限あり（snapshot生成を停止する）',
  );
  lines.push('');

  lines.push('## public schema の契約露出');
  lines.push('');
  lines.push(
    '`public` の view / SECURITY DEFINER 関数が versioned-contract の規約を守っているか。',
  );
  lines.push(
    'view は `security_invoker = true`・`_v<N>` 命名・`anon` 到達不可、definer 関数は `anon` 実行不可。',
  );
  lines.push('');
  lines.push(
    publicContractExposure.length === 0
      ? '- ✅ 違反なし'
      : '- ❌ 違反あり（snapshot生成を停止する）',
  );
  lines.push('');

  lines.push('## Realtime publication');
  lines.push('');
  lines.push('`supabase_realtime` に含まれる public table。空なら Realtime 公開なし。');
  lines.push('');
  if (realtimePublication.length === 0) {
    lines.push('- なし');
  } else {
    lines.push('| schema | table |');
    lines.push('| --- | --- |');
    for (const row of realtimePublication) {
      lines.push(`| ${cell(row.schemaname)} | ${cell(row.tablename)} |`);
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  let content: string;
  try {
    // 新設 public table がテナント分離の穴（RLS 無効 / policy 0 件）を持っていないかを
    // 最初に確認する。migration guard 系と同じく fail closed（#2596）。
    const tablesWithoutRlsProtection = fetchTablesWithoutRlsProtection();
    if (tablesWithoutRlsProtection.length > 0) {
      const violation = tablesWithoutRlsProtection[0]!;
      throw new Error(
        `public.${violation.table_name} has no RLS protection (rls=${violation.rls}, policies=${violation.policy_count}). ` +
          'RLS を有効化し policy を追加するか、deny-all が意図的なら PUBLIC_TABLES_WITHOUT_POLICIES_ALLOWLIST へ明示的に追加してください。',
      );
    }

    const effectiveTimeblockWritePrivileges = fetchEffectiveTimeblockWritePrivileges();
    if (effectiveTimeblockWritePrivileges.length > 0) {
      const violation = effectiveTimeblockWritePrivileges[0]!;
      throw new Error(
        `${violation.grantee} has effective ${violation.privilege_type} on ${violation.object_type} ${violation.object_name}`,
      );
    }

    // `public` の view / definer 関数が契約露出の規約を破った状態では snapshot を生成しない
    // （#2433）。上の timeblock 実効権限チェックと同じく fail closed にする — 描画するだけだと
    // 「drift が出た → 再生成して commit」で違反が追認される。
    const publicContractExposure = fetchPublicContractExposure();
    if (publicContractExposure.length > 0) {
      const violation = publicContractExposure[0]!;
      throw new Error(
        `public contract exposure: ${violation.violation_kind} on ${violation.object_type} ${violation.object_name} (${violation.detail})`,
      );
    }

    // allow-list 外の policy が `storage.objects` に付いた状態では snapshot を生成しない。
    // 描画するだけだと「drift が出た → 再生成して commit」の定型手順で rogue policy が
    // 追認されてしまい、防御が成果物の目視 diff まで落ちる。生成自体を止めれば、正当な
    // policy 追加は allow-list（`STORAGE_OBJECTS_APP_POLICY_NAMES`）の編集を強制でき、
    // レビュー面に必ず乗る。上の timeblock 実効権限チェックと同じ扱い。
    const unexpectedStoragePolicyNames = fetchUnexpectedStoragePolicyNames();
    if (unexpectedStoragePolicyNames.length > 0) {
      throw new Error(
        `unexpected storage.objects policy: ${unexpectedStoragePolicyNames.join(', ')}. ` +
          'app 所有なら STORAGE_OBJECTS_APP_POLICY_NAMES へ追加し、そうでなければ policy を削除する。',
      );
    }

    const raw = render({
      policies: fetchPolicies(),
      rlsTables: fetchRlsTables(),
      storagePolicies: fetchStoragePolicies(),
      storageObjectsRls: fetchStorageObjectsRls(),
      storageBuckets: fetchStorageBuckets(),
      unexpectedStoragePolicyNames,
      grants: fetchGrants(),
      privateOwners: fetchPrivateOwners(),
      privateRelationGrants: fetchPrivateRelationGrants(),
      privateColumnGrants: fetchPrivateColumnGrants(),
      privateRoutineGrants: fetchPrivateRoutineGrants(),
      privateTypeGrants: fetchPrivateTypeGrants(),
      privateSchemaUsage: fetchPrivateSchemaUsage(),
      realtimePublication: fetchRealtimePublication(),
      effectiveTimeblockWritePrivileges,
      publicContractExposure,
    });
    // commit 時の lint-staged prettier と同一整形を施し、--check の drift を防ぐ
    // （raw のままだと prettier がテーブルを整列して常に差分になる）
    content = await formatWithPrettier(raw, { parser: 'markdown', printWidth: 100 });
  } catch (error) {
    console.error(
      '❌ RLS snapshot 生成に失敗しました。DATABASE_URL と DB 起動を確認してください。',
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  if (CHECK_MODE) {
    const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (existing.trim() !== content.trim()) {
      console.error('❌ RLS snapshot が最新ではありません。');
      console.error('   pnpm rls:snapshot を実行して更新してください。');
      process.exit(1);
    }
    console.log('✅ RLS snapshot は最新です。');
    return;
  }

  writeFileSync(OUTPUT_PATH, content);
  console.log(`✅ RLS snapshot を生成しました: ${OUTPUT_PATH}`);
}

void main();
