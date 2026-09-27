import 'server-only';

import { env } from '@/env';
import { resolveSupabaseProjectRef } from '@/lib/dayopt-environment';

import { resolveOAuthEnvironmentConfig, type OAuthEnvironmentConfig } from './identity';

/**
 * env.ts は宣言だけで OAuth identity を検証しない（build phase / CI で validation を
 * skip する Proxy なので、cold start まで誤りが露出せずアプリ全体が 500 になる）。
 * 代わりにここで throw し、MCP / OAuth の route だけが 503 へ縮退する。
 *
 * `vercel env pull` 由来の値は末尾改行や空文字を含みうるため、identity 比較の前に
 * trim して空文字は未設定として扱う。
 */
export function getOAuthEnvironmentConfig(): OAuthEnvironmentConfig {
  return resolveOAuthEnvironmentConfig({
    mcpOAuthEnvironment: readTrimmedEnvValue(env.MCP_OAUTH_ENVIRONMENT),
    authorizationServerUri: readTrimmedEnvValue(env.OAUTH_AUTHORIZATION_SERVER_URI),
    resourceUri: readTrimmedEnvValue(env.MCP_CANONICAL_RESOURCE_URI),
    vercelEnvironment: readTrimmedEnvValue(env.VERCEL_ENV),
    vercelTargetEnvironment: readTrimmedEnvValue(env.VERCEL_TARGET_ENV),
    vercelBranchUrl: readTrimmedEnvValue(env.VERCEL_BRANCH_URL),
    vercelGitCommitRef: readTrimmedEnvValue(env.VERCEL_GIT_COMMIT_REF),
    mcpOAuthPreviewBranch: readTrimmedEnvValue(env.MCP_OAUTH_PREVIEW_BRANCH),
    dayoptEnvironment: readTrimmedEnvValue(env.DAYOPT_ENVIRONMENT),
    supabaseProjectRef: resolveSupabaseProjectRef(env.NEXT_PUBLIC_SUPABASE_URL),
  });
}

function readTrimmedEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
