import 'server-only';

import { env } from '@/env';

import { resolveOAuthEnvironmentFromEnv, type OAuthEnvironmentConfig } from './identity';

/**
 * env.ts は宣言だけで OAuth identity を検証しない（build phase / CI で validation を
 * skip する Proxy なので、cold start まで誤りが露出せずアプリ全体が 500 になる）。
 * 代わりにここで throw し、MCP / OAuth の route だけが 503 へ縮退する。
 *
 * `vercel env pull` 由来の値は末尾改行や空文字を含みうるため、identity 比較の前に
 * trim して空文字は未設定として扱う。
 */
export function getOAuthEnvironmentConfig(): OAuthEnvironmentConfig {
  return resolveOAuthEnvironmentFromEnv(env);
}
