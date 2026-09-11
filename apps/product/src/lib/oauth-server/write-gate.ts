import 'server-only';

import { databaseTables } from '@/lib/database';
import { logger } from '@/lib/logger';

import { isRuntimeClientWriteEnabled, type OAuthClientId } from './clients';
import type { createOAuthDbClient } from './db';

/**
 * MCP write gate は 2 つある（`docs/engineering/invariants.md` §MCP の DB 書き込み境界）:
 *
 *   1. runtime allowlist `MCP_WRITE_ENABLED_CLIENTS`（env / deploy 単位）
 *   2. `mcp_mutation_control` の `writes_enabled` × `enabled_client_ids`（DB / 即時）
 *
 * token 側（`lib/mcp/auth.ts` の `applyDurableWriteGate`）は毎リクエストこの AND を
 * 評価して write scope を落とす。consent 側も同じ AND で判定しないと、DB gate だけを
 * 閉じた直後（緊急停止の第一手）に `create_oauth_authorization_grant_v2` が `DM003` で
 * 例外になり、**その client からは read-only の新規接続すらできなくなる**。
 */
export function isWriteEnabledByMutationControl(
  control: { writes_enabled: boolean; enabled_client_ids: string[] } | null,
  clientId: OAuthClientId,
): boolean {
  if (!control) return false;
  return control.writes_enabled && control.enabled_client_ids.includes(clientId);
}

/**
 * consent 時点で write scope を付与してよいかを、env gate と DB gate の AND で決める。
 *
 * DB が読めない時は **write を落とす側へ倒す**（fail-closed）。read-only の grant は
 * 成立するので、接続そのものは失敗しない。
 */
export async function isConsentWriteEnabled(
  db: ReturnType<typeof createOAuthDbClient>,
  clientId: OAuthClientId,
): Promise<boolean> {
  if (!isRuntimeClientWriteEnabled(clientId)) return false;

  const { data: control, error } = await db
    .from(databaseTables.mcpMutationControl)
    .select('writes_enabled, enabled_client_ids')
    .eq('singleton_key', true)
    .maybeSingle();

  if (error) {
    logger.warn('[oauth] could not read the MCP mutation control; granting read-only scopes');
    return false;
  }

  return isWriteEnabledByMutationControl(control, clientId);
}
