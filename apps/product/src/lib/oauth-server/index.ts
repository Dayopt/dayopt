/**
 * OAuth 2.1 Authorization Server barrel.
 * /authorize, /token endpoints, PKCE (S256), opaque token issue/verify, static client allowlist.
 *
 * Write scopes / MCP mutation は DB gate (`mcp_mutation_control`) と runtime allowlist
 * (`MCP_WRITE_ENABLED_CLIENTS`) の二重 gate で閉じている。
 */

export { validateAuthorizeInput, type AuthorizeValidationError } from './authorize-validation';
export { isRuntimeClientWriteEnabled, resolveClient, type OAuthClientId } from './clients';
export {
  assertTokenIssuanceDatabaseIdentity,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './code-exchange';
export { createOAuthDbClient } from './db';
export { OAuthServerError } from './errors';
export { resolveRequestedResource, type CanonicalResourceUri } from './resource';
export {
  ADVERTISED_SCOPES,
  DEFAULT_SCOPES,
  hasWriteScope,
  isSupportedScope,
  isWriteScope,
  resolveGrantableScopes,
  type SupportedScope,
} from './scopes';
export { generateAuthorizationCode, hashToken } from './tokens';
export { isConsentWriteEnabled, isWriteEnabledByMutationControl } from './write-gate';
