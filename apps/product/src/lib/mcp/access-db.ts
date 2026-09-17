import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';

/** Service-role surface used only while verifying an MCP access token. */
type McpAccessDatabase = {
  public: {
    Tables: Pick<
      Database['public']['Tables'],
      'mcp_mutation_control' | 'oauth_connections' | 'oauth_tokens' | 'profiles'
    >;
    Views: Record<string, never>;
    Functions: Pick<Database['public']['Functions'], 'get_mcp_environment_identity_v1'>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type McpAccessSupabaseClient = SupabaseClient<McpAccessDatabase>;

/**
 * 外部呼び出しの上限。他の service-role client と同値。
 *
 * token 検証は identity RPC → token → connection → write gate → profile を逐次で引く。
 * 上限が無いと route の `maxDuration` が先に発火し、handler が返すはずの 503 すら
 * 出せずに全 tool 呼び出しが 504 になる。
 */
const MCP_ACCESS_DB_TIMEOUT_MS = 15_000;

export function createMcpAccessDbClient(): McpAccessSupabaseClient {
  return createClient<McpAccessDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: (url, options) => {
        return fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(MCP_ACCESS_DB_TIMEOUT_MS),
        });
      },
    },
  });
}
