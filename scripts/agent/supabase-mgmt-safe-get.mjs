import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  AUTH_CONFIG_CONTRACT,
  SUPABASE_PRODUCTION_PROJECT_REF,
} from '../ci/production-auth-config-audit.mjs';

/**
 * Supabase Management API の `GET /v1/projects/{ref}/config/auth` を、field allowlist
 * 射影を通した値だけ返す安全な wrapper（#2293）。
 *
 * `config/auth` の生応答には `security_captcha_secret` 等の secret が同梱されるため、
 * agent が curl / wget で直接叩くことは `scripts/hooks/pre-tool-guard-rules.mjs` が block
 * する（denylist keyword フィルタ・部分一致フィルタが 2026-08-11 に 2 回とも漏れた同型
 * incident を再発させないため）。安全な確認経路をこの wrapper 1 本に一本化する。
 *
 * allowlist は `production-auth-config-audit.mjs` が export する `AUTH_CONFIG_CONTRACT`
 * から派生させる（二重管理を避ける）。ただし `redact: 'url'` が付いた entry
 * （`hook_send_email_uri`。query / userinfo / path のいずれにも credential が入りうる URI）
 * は allowlist から除外し、この wrapper 経由でも値を返さない。それ以外（boolean / enum /
 * 数値 / secretになり得ないURL）だけを直接返す。
 *
 * 使い方（token は agent vault の read-only scoped token。CLI 引数へ載せず inline env var +
 * op run で解決する。write を含む human/supabase-cli は使わない。2026-09-14 監査 P2-7）:
 *
 *   SUPABASE_ACCESS_TOKEN="op://agent/supabase-readonly/credential" \
 *     op run -- node scripts/agent/supabase-mgmt-safe-get.mjs auth-config <field1> [field2 ...]
 */

const NON_REDACTED_ENTRIES = AUTH_CONFIG_CONTRACT.filter((entry) => entry.redact !== 'url');
export const SAFE_AUTH_CONFIG_FIELDS = new Set(NON_REDACTED_ENTRIES.map((entry) => entry.key));

function usage() {
  const fields = [...SAFE_AUTH_CONFIG_FIELDS].sort();
  console.error(
    'Usage: node scripts/agent/supabase-mgmt-safe-get.mjs auth-config <field1> [field2 ...]',
  );
  console.error(`許可されている field（${fields.length} 件）: ${fields.join(', ')}`);
}

async function fetchAuthConfig(projectRef, token, fetchImpl) {
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  // 本文には secret が同梱されるため、失敗時もレスポンスを出力しない
  // （production-auth-config-audit.mjs と同じ不変条件）。
  if (!response.ok) {
    throw new Error(`Supabase Auth config request failed for project: ${projectRef}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`Supabase Auth config response was not JSON for project: ${projectRef}`);
  }
}

/**
 * 指定した field だけを allowlist 射影して返す。allowlist 外の field を 1 つでも含む
 * 要求は、他が allowlist 内でも**全体を拒否**する（部分的に応じると、agent が allowlist
 * 外の field を紛れ込ませて値を得られてしまう）。
 */
export async function runAuthConfigSafeGet({
  fields,
  token,
  projectRef = SUPABASE_PRODUCTION_PROJECT_REF,
  fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('少なくとも 1 つの field を指定してください');
  }

  const disallowed = fields.filter((field) => !SAFE_AUTH_CONFIG_FIELDS.has(field));
  if (disallowed.length > 0) {
    throw new Error(
      `許可されていない field です（値は返しません）: ${disallowed.join(', ')}。--help で許可 field 一覧を確認してください`,
    );
  }

  const config = await fetchAuthConfig(projectRef, token, fetchImpl);
  const result = {};
  for (const field of fields) {
    result[field] = Object.prototype.hasOwnProperty.call(config, field) ? config[field] : null;
  }
  return result;
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
  const [subcommand, ...fields] = process.argv.slice(2);

  if (subcommand !== 'auth-config' || fields.length === 0) {
    usage();
    process.exitCode = 1;
  } else {
    runAuthConfigSafeGet({ fields, token: process.env.SUPABASE_ACCESS_TOKEN })
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'supabase-mgmt-safe-get failed');
        process.exitCode = 1;
      });
  }
}
