import 'server-only';

import { isAllowedRedirectUri, resolveClient, type OAuthClient } from './clients';
import { resolveRequestedResource, type CanonicalResourceUri } from './resource';
import { hasWriteScope, parseRequestedScope, type SupportedScope } from './scopes';

/**
 * `/oauth/authorize` の入力 (raw query string) を検証する。
 *
 * Phase 1 では PKCE S256 と response_type=code のみ受け付ける。
 * client_id / redirect_uri は static allowlist 照合 (Phase 2 で DCR に置換)。
 */
interface AuthorizeInput {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  resource?: string | undefined;
}

export type AuthorizeValidationError =
  | 'unsupported_response_type'
  | 'invalid_client'
  | 'invalid_redirect_uri'
  | 'missing_pkce'
  | 'invalid_scope'
  | 'invalid_resource';

type AuthorizeValidationResult =
  | {
      ok: true;
      client: OAuthClient;
      scopes: SupportedScope[];
      redirectUri: string;
      codeChallenge: string;
      state: string | null;
      resourceUri: CanonicalResourceUri;
    }
  | { ok: false; error: AuthorizeValidationError };

export function validateAuthorizeInput(input: AuthorizeInput): AuthorizeValidationResult {
  if (input.response_type !== 'code') {
    return { ok: false, error: 'unsupported_response_type' };
  }
  const client = resolveClient(input.client_id ?? null);
  if (!client) {
    return { ok: false, error: 'invalid_client' };
  }
  if (!input.redirect_uri || !isAllowedRedirectUri(client, input.redirect_uri)) {
    return { ok: false, error: 'invalid_redirect_uri' };
  }
  if (
    !input.code_challenge ||
    input.code_challenge_method !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge)
  ) {
    return { ok: false, error: 'missing_pkce' };
  }
  const resourceUri = resolveRequestedResource(input.resource);
  if (!resourceUri) {
    return { ok: false, error: 'invalid_resource' };
  }
  const scopes = parseRequestedScope(input.scope);
  const requestsWrite = scopes !== null && hasWriteScope(scopes);
  // write gate（env / DB）の判定はここでは行わない。metadata が全 scope を広告する以上、
  // gate が閉じている client も write を要求してくるのが正常系で、ここで弾くと
  // read-only 接続まで作れなくなる。付与時に consent 側が write を落とす
  // （`resolveGrantableScopes`）。DB の整合条件である read:entries の同伴だけ、
  // grant RPC より前に 400 で返す。
  if (scopes === null || (requestsWrite && !scopes.includes('read:entries'))) {
    return { ok: false, error: 'invalid_scope' };
  }
  return {
    ok: true,
    client,
    scopes,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    state: input.state ?? null,
    resourceUri,
  };
}
