import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  STORAGE_OBJECTS_APP_POLICY_NAMES,
  sqlStringList,
} from '../lib/storage-objects-app-policy-names.mjs';
import { SUPABASE_PRODUCTION_PROJECT_REF } from './production-auth-config-audit.mjs';

/**
 * production の `storage.objects` RLS drift を継続検出する（#2323）。
 *
 * `pnpm rls:snapshot:check`（`scripts/tasks/generate-rls-snapshot.ts`）は migration から構築した
 * **ephemeral な local DB** しか見ない。production の実 state（Dashboard 経由の手動変更、
 * migration の DROP 漏れで残存した legacy policy 等）はこれまで一度も直接検査されて
 * こなかった —— #2316 の root cause（`_archive/20251024022910_remote_schema.sql` /
 * `_archive/20251218072948_create_attachments_bucket.sql` が作った legacy policy が
 * 一度も DROP されず production にだけ残存していた）はまさにこの盲点が実際に踏まれた例で、
 * この script はその再発を検出する。
 *
 * ## 接続経路（read-only）
 *
 * Supabase Management API の `POST /v1/projects/{ref}/database/query` を
 * `read_only: true` フラグ付きで叩く。このフラグは API サーバー側で強制され、書き込み系
 * SQL は拒否される（クライアントの自己申告ではない。
 * https://supabase.com/docs/reference/api/v1-run-a-query）。token 自体も `database_read`
 * 権限のみを持つ scoped project token を使う運用を前提にする（発行手順は #2345）。
 *
 * **ただし `database_read` は table 単位で絞れない。** この token は production の
 * schema 全体（`auth.users` を含む）への SELECT を許可する広い scope で、
 * `storage.objects` だけに絞る Supabase 側の機能は無い（2026-08-24 時点）。実際にこの
 * script が実行する SELECT は `storage.objects` の policy 名と RLS 状態のみに限定して
 * いるが、それは script の実装が守る境界であって token 自体の scope ではない。
 *
 * ## 保証境界（どこまでを守り、どこからを守らないか）
 *
 * `AGENTS.md §PR / git 運用` §同型指摘の打ち切り に倣い、守る範囲を先に宣言する。
 *
 * **守る**:
 *
 * 1. `storage.objects` の policy 名が `STORAGE_OBJECTS_APP_POLICY_NAMES`
 *    （`../lib/storage-objects-app-policy-names.mjs` が正本）の外に出ていないか
 * 2. `storage.objects` の RLS が有効なままか（policy が残っていても
 *    `ENABLE ROW LEVEL SECURITY` が外れれば無力化される。local snapshot の
 *    `fetchStorageObjectsRls()` と同じ懸念）
 * 3. `storage.objects` に想定外の `FORCE ROW LEVEL SECURITY` が付いていないか
 *    （この repo は使っていない設定なので、値の変化自体が意図しない変更のシグナル）
 * 4. `storage.buckets` の `avatars` 行が `EXPECTED_AVATARS_BUCKET`（`supabase/config.toml`
 *    の `[storage.buckets.avatars]` を正本とする値。#2449）と一致しているか。`config.toml`
 *    は GitHub integration の Deploy to production / Automatic branching 経由で
 *    production へ同期される実効的な正本（[issue #1523 のコメント欄](https://github.com/Dayopt/dayopt/issues/1523)
 *    §bucket の正本は config.toml と migration に割れている、旧 migration-baseline-squash/overview.md。
 *    docs/projects 全廃に伴い #2473 で移設。参照）で、`avatars` バケットを設定する migration は存在しない。したがって drift は
 *    Dashboard 経由の手動変更、または `config.toml` の同期不備でしか起こり得ない
 *
 * **守らない**:
 *
 * - **policy の USING / WITH CHECK 句の中身は誰も見ていない。** allow-list に載った
 *   policy 名の句が Dashboard 経由で `true` へ書き換えられても、この script は検出
 *   しない（policy 名だけを追跡するため）。local snapshot（`generate-rls-snapshot.ts`）
 *   も migration から構築した ephemeral DB しか見ないため、production の実際の句の内容
 *   はこの 2 script のどちらにもカバーされない
 * - **`storage.buckets` は `avatars` 行だけを見る**（#2449）。`attachments` 行は
 *   `config.toml` に宣言が無く baseline migration の `INSERT` が唯一の供給元のため、
 *   ここで検出したい「config.toml との drift」という枠組みに乗らない。`attachments` の
 *   drift 監視が必要になったら別途 baseline との突き合わせ設計が要る（拡張は別 issue）
 * - `storage.objects` 以外の table の policy
 *   （production-config-audit.mjs の Vercel drift、production-auth-config-audit.mjs の
 *   Auth drift と同様、この script は 1 つの狭い一次防御線として設計する。拡張は別 issue）
 * - migration を経由しない DB スキーマ変更全般（table 追加・GRANT 変更等）。あくまで
 *   `storage.objects` の RLS 境界と `storage.buckets.avatars` の metadata のみ
 * - **allow-list 内 policy の欠落（DROP 方向）は積極的には検出しない。** `storage.objects`
 *   の policy はすべて PERMISSIVE（`generate-rls-snapshot.ts` の同種 policy と同じ前提）
 *   なので、8 件のうち 1 件が Dashboard 経由で誤って DROP されても access 自体は他の
 *   PERMISSIVE policy の OR 評価で fail-closed 側（より制限が強まる方向）に倒れる。
 *   `auditProductionStorageRls()` は `unexpected_policies`（allow-list 外の混入）だけを
 *   見ており、`STORAGE_OBJECTS_APP_POLICY_NAMES` の 8 件が実際に存在するかは確認しない。
 *   欠落自体はセキュリティ後退ではないため本 script の scope 外に据え置くが、想定した
 *   保護（例: 添付ファイルの owner 制限）が意図せず消えている状態を機械検出したくなったら
 *   `fetchStoragePolicies()` 相当の存在確認を別途追加する判断になる
 */

/**
 * `supabase/config.toml` の `[storage.buckets.avatars]` を正本値として写す（#2449）。
 * config.toml 側を変更したら、この定数も同じ commit で更新する（二重管理だが、config.toml
 * は TOML でこの script から直接 parse する既存経路が無いため、値そのものを写経する）。
 */
export const EXPECTED_AVATARS_BUCKET = {
  public: true,
  file_size_limit: 5242880, // 5MiB
  allowed_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
};

async function runReadOnlyQuery({ projectRef, token, query, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, read_only: true }),
    },
  );

  // 本文に予期しない内容が含まれた場合に備え、失敗時はレスポンスをそのまま出力しない
  // （production-auth-config-audit.mjs と同じ不変条件）。
  if (!response.ok) {
    // 401 は「token が invalid」以外に「token の 90 日期限切れ」でも起こる
    // （docs/operations/secrets-ledger.md の supabase-storage-rls-audit item 参照）。
    // 呼び出し元が rotation を疑うべきタイミングを明示するヒントを添える。
    const hint =
      response.status === 401
        ? ' — SUPABASE_STORAGE_RLS_AUDIT_TOKEN の期限切れ（90日）または失効の可能性。docs/operations/secrets-ledger.md 参照'
        : '';
    throw new Error(
      `Supabase database query request failed for project: ${projectRef} (status ${response.status})${hint}`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`Supabase database query response was not JSON for project: ${projectRef}`);
  }
}

/** contract test（read-only SQL のみであることの機械固定）のため export する。 */
export function buildQuery() {
  return `SELECT
    (SELECT coalesce(json_agg(policyname ORDER BY policyname), '[]'::json)
     FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname NOT IN (${sqlStringList(STORAGE_OBJECTS_APP_POLICY_NAMES)})) AS unexpected_policies,
    (SELECT c.relrowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects') AS rls_enabled,
    (SELECT c.relforcerowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects') AS rls_forced,
    (SELECT json_build_object(
       'public', b.public,
       'file_size_limit', b.file_size_limit,
       'allowed_mime_types', b.allowed_mime_types
     ) FROM storage.buckets b WHERE b.id = 'avatars') AS avatars_bucket;`;
}

/**
 * 配列を「集合として」比較する（順序差は drift と数えない。Postgres の配列は
 * insertion order を保持するが、それに依存した比較にしない）。
 */
function arraysEqualAsSets(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * `avatars_bucket` 1 行を `EXPECTED_AVATARS_BUCKET` と突き合わせる（#2449）。
 * drift 内容を全件返す（1 件目で止めない。複数フィールドが同時にずれていても
 * 1 回の実行で全体像が分かるようにする — 他のチェックと同じ方針）。
 */
function describeAvatarsBucketDrift(bucket) {
  const drifts = [];

  if (bucket.public !== EXPECTED_AVATARS_BUCKET.public) {
    drifts.push(`public: expected ${EXPECTED_AVATARS_BUCKET.public}, got ${bucket.public}`);
  }

  if (bucket.file_size_limit !== EXPECTED_AVATARS_BUCKET.file_size_limit) {
    drifts.push(
      `file_size_limit: expected ${EXPECTED_AVATARS_BUCKET.file_size_limit}, got ${bucket.file_size_limit}`,
    );
  }

  const allowedMimeTypes = Array.isArray(bucket.allowed_mime_types)
    ? bucket.allowed_mime_types
    : [];
  if (!arraysEqualAsSets(allowedMimeTypes, EXPECTED_AVATARS_BUCKET.allowed_mime_types)) {
    drifts.push(
      `allowed_mime_types: expected [${EXPECTED_AVATARS_BUCKET.allowed_mime_types.join(', ')}], got [${allowedMimeTypes.join(', ')}]`,
    );
  }

  return drifts;
}

/**
 * fail closed: 想定外の response shape は「確認できた」に倒さない
 * （production-auth-config-audit.mjs の key 欠落判定と同じ思想）。
 */
export function auditProductionStorageRls(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return [
      `production storage RLS query returned an unexpected shape (expected exactly 1 row, got ${
        Array.isArray(rows) ? `${rows.length} rows` : typeof rows
      })`,
    ];
  }

  const row = rows[0];
  if (
    !row ||
    typeof row !== 'object' ||
    !Array.isArray(row.unexpected_policies) ||
    typeof row.rls_enabled !== 'boolean' ||
    typeof row.rls_forced !== 'boolean' ||
    // avatars_bucket は必ず json_build_object の結果（non-null オブジェクト）を期待する。
    // null（bucket が存在しない）は「確認できた」に倒さず shape error にする（fail closed）。
    !row.avatars_bucket ||
    typeof row.avatars_bucket !== 'object' ||
    typeof row.avatars_bucket.public !== 'boolean'
  ) {
    return ['production storage RLS query returned an unexpected row shape'];
  }

  const errors = [];

  if (row.unexpected_policies.length > 0) {
    errors.push(
      `unexpected storage.objects policy on production: ${row.unexpected_policies.join(', ')}. ` +
        'app 所有なら STORAGE_OBJECTS_APP_POLICY_NAMES へ追加してから production へ反映する。' +
        'そうでなければ legacy policy を DROP する migration を作る（#2316 と同型の drift）。',
    );
  }

  if (row.rls_enabled !== true) {
    errors.push(
      'storage.objects の RLS が無効化されています（ENABLE ROW LEVEL SECURITY が外れている）',
    );
  }

  if (row.rls_forced === true) {
    errors.push(
      'storage.objects で ROW LEVEL SECURITY が FORCE されています（この repo は使っていない設定 — 想定外の変更）',
    );
  }

  const avatarsBucketDrifts = describeAvatarsBucketDrift(row.avatars_bucket);
  if (avatarsBucketDrifts.length > 0) {
    errors.push(
      `avatars bucket metadata drifted from supabase/config.toml (${avatarsBucketDrifts.join('; ')}). ` +
        'production 側が正しい場合は config.toml を実測値に合わせる。config.toml 側が正しい場合は ' +
        'Dashboard 側の意図しない変更を production へ戻す（#2449）。',
    );
  }

  return errors;
}

export async function runProductionStorageRlsAudit({
  token,
  projectRef = SUPABASE_PRODUCTION_PROJECT_REF,
  fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error(
      'SUPABASE_STORAGE_RLS_AUDIT_TOKEN is required for Production Storage RLS Audit',
    );
  }

  const rows = await runReadOnlyQuery({ projectRef, token, query: buildQuery(), fetchImpl });
  const errors = auditProductionStorageRls(rows);

  if (errors.length > 0) {
    throw new Error(
      `Production Storage RLS Audit failed:\n${errors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
}

/** production-auth-config-audit.mjs と同じ正規化比較（symlink / 空白 path 対応）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  // SUPABASE_STORAGE_RLS_AUDIT_TOKEN は 2026-08-25（#2345）に発行・GitHub Secret 登録
  // 済み。発行前は token 未設定を `::notice::` + exit 0 で許容していたが、発行済みに
  // なった今その分岐を残すと「token が後日失効・削除されても audit が黙って no-op の
  // 緑になる」false-green 経路になる（#2449 で発見）。production-auth-config-audit.mjs
  // と同じ「token 未設定は即 throw」へ揃え、runProductionStorageRlsAudit 自身の
  // `token が required` チェックにそのまま委ねる（中間状態を持たない）。
  runProductionStorageRlsAudit({ token: process.env.SUPABASE_STORAGE_RLS_AUDIT_TOKEN })
    .then(() => {
      console.log(
        'Production Storage RLS Audit passed (storage.objects allow-list + avatars bucket metadata).',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Production Storage RLS Audit failed');
      process.exitCode = 1;
    });
}
