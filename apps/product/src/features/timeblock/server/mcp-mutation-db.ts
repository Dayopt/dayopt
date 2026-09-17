import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';

/** Service-role surface restricted to typed MCP mutation RPCs. */
type NoDatabaseObjects = { [_ in never]: never };

type McpMutationDatabase = {
  public: {
    Tables: NoDatabaseObjects;
    Views: NoDatabaseObjects;
    Functions: Pick<
      Database['public']['Functions'],
      | 'apply_mcp_plan_create_v1'
      | 'apply_mcp_plan_delete_v1'
      | 'apply_mcp_plan_restore_v1'
      | 'apply_mcp_plan_update_v1'
      | 'apply_mcp_record_create_v1'
      | 'apply_mcp_record_delete_v1'
      | 'apply_mcp_record_restore_v1'
      | 'apply_mcp_record_update_v1'
    >;
    Enums: NoDatabaseObjects;
    CompositeTypes: NoDatabaseObjects;
  };
};

type McpMutationDbClient = SupabaseClient<McpMutationDatabase>;
type GeneratedPlanCreateRpcArgs =
  Database['public']['Functions']['apply_mcp_plan_create_v1']['Args'];
// 生成型は DEFAULT 付き引数を `p_activity_id?: string` として出すので、null を
// 渡せるよう明示的に上書きする（p_note と同じ扱い）。present flag も
// optional から必須へ上げて、呼び出し側が三状態を必ず明示するようにする。
type PlanCreateRpcArgs = Omit<GeneratedPlanCreateRpcArgs, 'p_activity_id' | 'p_note'> & {
  p_activity_id: string | null;
  p_note: string | null;
};
type GeneratedPlanUpdateRpcArgs =
  Database['public']['Functions']['apply_mcp_plan_update_v1']['Args'];
type PlanUpdateRpcArgs = Omit<
  GeneratedPlanUpdateRpcArgs,
  'p_activity_id' | 'p_activity_id_present' | 'p_end_at' | 'p_note' | 'p_start_at' | 'p_title'
> & {
  p_activity_id: string | null;
  p_activity_id_present: boolean;
  p_end_at: string | null;
  p_note: string | null;
  p_start_at: string | null;
  p_title: string | null;
};
type PlanDeleteRpcArgs = Database['public']['Functions']['apply_mcp_plan_delete_v1']['Args'];
type PlanRestoreRpcArgs = Database['public']['Functions']['apply_mcp_plan_restore_v1']['Args'];
type GeneratedRecordCreateRpcArgs =
  Database['public']['Functions']['apply_mcp_record_create_v1']['Args'];
type RecordCreateRpcArgs = Omit<
  GeneratedRecordCreateRpcArgs,
  'p_activity_id' | 'p_fulfillment' | 'p_note' | 'p_plan_id'
> & {
  p_activity_id: string | null;
  p_fulfillment: string | null;
  p_note: string | null;
  p_plan_id: string | null;
};
type GeneratedRecordUpdateRpcArgs =
  Database['public']['Functions']['apply_mcp_record_update_v1']['Args'];
type RecordUpdateRpcArgs = Omit<
  GeneratedRecordUpdateRpcArgs,
  | 'p_activity_id'
  | 'p_activity_id_present'
  | 'p_end_at'
  | 'p_fulfillment'
  | 'p_fulfillment_present'
  | 'p_note'
  | 'p_start_at'
  | 'p_title'
> & {
  p_activity_id: string | null;
  p_activity_id_present: boolean;
  p_end_at: string | null;
  p_fulfillment: string | null;
  p_fulfillment_present: boolean;
  p_note: string | null;
  p_start_at: string | null;
  p_title: string | null;
};
type RecordDeleteRpcArgs = Database['public']['Functions']['apply_mcp_record_delete_v1']['Args'];
type RecordRestoreRpcArgs = Database['public']['Functions']['apply_mcp_record_restore_v1']['Args'];

function createMcpMutationDbClient(): McpMutationDbClient {
  return createClient<McpMutationDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(15_000),
        }),
    },
  });
}

/** Exposes typed apply methods without exposing the underlying service-role client. */
export function createMcpMutationDb() {
  const client = createMcpMutationDbClient();

  return {
    applyPlanCreate: async (args: PlanCreateRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_plan_create_v1', {
        ...args,
        p_activity_id: args.p_activity_id as never,
        p_note: args.p_note as never,
      });
      return { data, error };
    },
    applyPlanUpdate: async (args: PlanUpdateRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_plan_update_v1', {
        ...args,
        p_activity_id: args.p_activity_id as never,
        p_end_at: args.p_end_at as never,
        p_note: args.p_note as never,
        p_start_at: args.p_start_at as never,
        p_title: args.p_title as never,
      });
      return { data, error };
    },
    applyPlanDelete: async (args: PlanDeleteRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_plan_delete_v1', args);
      return { data, error };
    },
    applyPlanRestore: async (args: PlanRestoreRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_plan_restore_v1', args);
      return { data, error };
    },
    applyRecordCreate: async (args: RecordCreateRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_record_create_v1', {
        ...args,
        p_activity_id: args.p_activity_id as never,
        p_fulfillment: args.p_fulfillment as never,
        p_note: args.p_note as never,
        p_plan_id: args.p_plan_id as never,
      });
      return { data, error };
    },
    applyRecordUpdate: async (args: RecordUpdateRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_record_update_v1', {
        ...args,
        p_activity_id: args.p_activity_id as never,
        p_end_at: args.p_end_at as never,
        p_fulfillment: args.p_fulfillment as never,
        p_note: args.p_note as never,
        p_start_at: args.p_start_at as never,
        p_title: args.p_title as never,
      });
      return { data, error };
    },
    applyRecordDelete: async (args: RecordDeleteRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_record_delete_v1', args);
      return { data, error };
    },
    applyRecordRestore: async (args: RecordRestoreRpcArgs) => {
      const { data, error } = await client.rpc('apply_mcp_record_restore_v1', args);
      return { data, error };
    },
  };
}
