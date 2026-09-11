import 'server-only';

/** OAuth grants that Dayopt understands. Tool discovery is filtered separately. */
export const SUPPORTED_SCOPES = [
  'read:entries',
  'read:activities',
  'read:constraints',
  'read:stats',
  'write:plans',
  'delete:plans',
  'write:records',
  'delete:records',
] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

/**
 * Public metadata advertises every supported scope.
 *
 * client（Claude 等）は `scopes_supported` をそのまま authorize へ載せるため、
 * write scope を広告しないと **gate を全部開けても write が一生要求されない**。
 * 広告は「この AS が理解する scope」の宣言であって付与の約束ではなく、実際に
 * 何を付与するかは consent の `resolveGrantableScopes` が client 単位の runtime
 * gate（`MCP_WRITE_ENABLED_CLIENTS`）で決める。gate が閉じている client は
 * write を落とした read だけの grant になり、consent は失敗しない。
 */
export const ADVERTISED_SCOPES: readonly SupportedScope[] = [...SUPPORTED_SCOPES];

const WRITE_SCOPES = [
  'write:plans',
  'delete:plans',
  'write:records',
  'delete:records',
] as const satisfies readonly SupportedScope[];

export const DEFAULT_SCOPES = ['read:entries'] as const satisfies readonly SupportedScope[];

/**
 * 戻り値:
 *   - scope param 省略時: DEFAULT_SCOPES (OAuth spec 上 client がデフォルト想定で OK)
 * Explicit scope input is all-or-nothing. Silently dropping an unknown scope
 * would make the consent screen authorize a different grant than the client
 * requested.
 */
export function parseRequestedScope(
  scopeParam: string | null | undefined,
): SupportedScope[] | null {
  if (!scopeParam) return [...DEFAULT_SCOPES];
  const requested = scopeParam.split(/\s+/).filter(Boolean);
  if (requested.length === 0) return [...DEFAULT_SCOPES];
  if (!requested.every(isSupportedScope)) return null;
  return [...new Set(requested)];
}

export function isSupportedScope(scope: string): scope is SupportedScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(scope);
}

export function isWriteScope(scope: SupportedScope): boolean {
  return (WRITE_SCOPES as readonly SupportedScope[]).includes(scope);
}

export function hasWriteScope(scopes: readonly SupportedScope[]): boolean {
  return scopes.some(isWriteScope);
}

/**
 * consent で実際に付与する scope を決める。
 *
 * `create_oauth_authorization_grant_v2` は write scope を要求されたまま gate が
 * 閉じていると **例外で拒否する**（42501 / DM003）。広告を全 scope へ広げた以上、
 * gate 未開放の client は毎回 consent が失敗することになるので、付与側で write を
 * 落として read-only の grant へ降格させる。read だけが残るため
 * 「write scope は read:entries を伴う」という DB 側の整合 CHECK も自動で満たす。
 */
export function resolveGrantableScopes(
  requested: readonly SupportedScope[],
  writeEnabledForClient: boolean,
): SupportedScope[] {
  if (writeEnabledForClient) return [...requested];
  return requested.filter((scope) => !isWriteScope(scope));
}
