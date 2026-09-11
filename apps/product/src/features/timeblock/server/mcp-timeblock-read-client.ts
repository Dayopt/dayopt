import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

const PLAN_TRASH_SELECT =
  'id, title, note, activity_id, start_at, end_at, source, deleted_at, created_at, updated_at' as const;
const RECORD_TRASH_SELECT =
  'id, title, note, activity_id, start_at, end_at, source, fulfillment, deleted_at, created_at, updated_at' as const;

type TimeblockTrashDatabase = {
  public: {
    Tables: Pick<Database['public']['Tables'], 'plans' | 'records'>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

interface PlanReadRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  source: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RecordReadRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  source: string;
  fulfillment: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export class TimeblockTrashReadError extends Error {
  constructor() {
    super('Dayopt timeblock data could not be read');
    this.name = 'TimeblockTrashReadError';
  }
}

class TimeblockTrashReadClient {
  private readonly db = createTimeblockTrashDbClient();

  async listDeletedPlans(userId: string, limit: number) {
    const { data, error } = await this.db
      .from('plans')
      .select(PLAN_TRASH_SELECT)
      .eq('user_id', userId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit);

    if (error) throwReadError(error, 'list_deleted_plans');
    return data ?? [];
  }

  async listDeletedRecords(userId: string, limit: number) {
    const { data, error } = await this.db
      .from('records')
      .select(RECORD_TRASH_SELECT)
      .eq('user_id', userId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit);

    if (error) throwReadError(error, 'list_deleted_records');
    return data ?? [];
  }
}

export function createTimeblockTrashReadClient() {
  return new TimeblockTrashReadClient();
}

export function transformPlanReadModel(row: PlanReadRow) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    activityId: row.activity_id,
    startAt: row.start_at,
    endAt: row.end_at,
    source: row.source,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function transformRecordReadModel(row: RecordReadRow) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    activityId: row.activity_id,
    startAt: row.start_at,
    endAt: row.end_at,
    source: row.source,
    fulfillment: row.fulfillment,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createTimeblockTrashDbClient(): SupabaseClient<TimeblockTrashDatabase> {
  return createClient<TimeblockTrashDatabase>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
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
    },
  );
}

function throwReadError(error: unknown, operation: string): never {
  captureUnexpectedDatabaseError(error, { feature: 'mcp', operation });
  throw new TimeblockTrashReadError();
}
