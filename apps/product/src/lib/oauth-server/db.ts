import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';

/**
 * OAuth 用 service-role client が触れる surface だけに narrow した DB 型。
 *
 * RLS bypass する client なので、他テーブル (entries / tags / etc.) や rpc / view を
 * 誤って query すると cross-tenant leak になる。Tables と Functions は OAuth の
 * connection/token lifecycle に限定し、`from('plans')` や任意 RPC は compile error
 * にする。
 */
type OAuthOnlyDatabase = {
  public: {
    Tables: Pick<
      Database['public']['Tables'],
      | 'oauth_tokens'
      | 'oauth_authorization_codes'
      | 'oauth_connections'
      // consent の write gate 判定に使う singleton（read-only、tenant data ではない）
      | 'mcp_mutation_control'
    >;
    Views: Record<string, never>;
    Functions: Pick<
      Database['public']['Functions'],
      | 'create_oauth_authorization_grant_v2'
      | 'exchange_oauth_authorization_code_v2'
      | 'get_mcp_environment_identity_v1'
      | 'rotate_oauth_refresh_token_v2'
    >;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type OAuthSupabaseClient = SupabaseClient<OAuthOnlyDatabase>;

/**
 * 外部呼び出しの上限。`lib/supabase/server.ts` / `lib/supabase/oauth.ts` の client と同値。
 *
 * この client が無制限だと、route の `maxDuration` だけが先に発火して Function が kill
 * される。token endpoint が触る `exchange_oauth_authorization_code_v2` /
 * `rotate_oauth_refresh_token_v2` は **1 回しか使えない** grant を消費するため、
 * 「サーバー側では成功したがレスポンスが返らない」状態になると、client は再試行しても
 * 使用済みエラーで詰む。内側で先に切って正規の OAuth エラーを返す方が回復可能。
 */
const OAUTH_DB_TIMEOUT_MS = 15_000;

export function createOAuthDbClient(): OAuthSupabaseClient {
  return createClient<OAuthOnlyDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: (url, options) => {
        return fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(OAUTH_DB_TIMEOUT_MS),
        });
      },
    },
  });
}
