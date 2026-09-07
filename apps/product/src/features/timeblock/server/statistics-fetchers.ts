import { collectQueryPages } from '@/lib/database/collect-query-pages';
import 'server-only';

/**
 * 統計 service 共通の行取得
 *
 * Aggregation Source Contract に従い、実績系は `records`、予定系は `plans` を読む。
 */

import { databaseTables } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import type { ServiceSupabaseClient } from './types';

export interface StatPlanRow {
  id: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
}

interface StatRecordRow {
  id: string;
  activity_id: string | null;
  source: string;
  start_at: string;
  end_at: string;
}

export interface ActivityLookupRow {
  id: string;
  name: string;
  /** カテゴリー未所属は null */
  category_id: string | null;
}

export interface CategoryLookupRow {
  id: string;
  name: string;
  /** 実 schema では nullable。色なしのカテゴリーがありうる */
  color: string | null;
  icon: string | null;
}

export interface DateRangeInput {
  startDate?: string | undefined;
  endDate?: string | undefined;
}

export async function fetchRecords(
  supabase: ServiceSupabaseClient,
  userId: string,
  range: DateRangeInput = {},
): Promise<StatRecordRow[]> {
  let query = supabase
    .from(databaseTables.records)
    .select('id, activity_id, source, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (range.startDate) query = query.gt('end_at', range.startDate);
  if (range.endDate) query = query.lt('start_at', range.endDate);

  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'statistics',
      operation: 'fetch_records',
    });
  }
  return (data ?? []).map((row) => ({
    ...row,
    start_at:
      range.startDate && Date.parse(row.start_at) < Date.parse(range.startDate)
        ? range.startDate
        : row.start_at,
    end_at:
      range.endDate && Date.parse(row.end_at) > Date.parse(range.endDate)
        ? range.endDate
        : row.end_at,
  }));
}

export async function fetchPlans(
  supabase: ServiceSupabaseClient,
  userId: string,
  range: DateRangeInput = {},
): Promise<StatPlanRow[]> {
  let query = supabase
    .from('plans')
    .select('id, activity_id, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (range.startDate) query = query.gt('end_at', range.startDate);
  if (range.endDate) query = query.lt('start_at', range.endDate);

  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'statistics',
      operation: 'fetch_plans',
    });
  }
  return (data ?? []).map((row) => ({
    ...row,
    start_at:
      range.startDate && Date.parse(row.start_at) < Date.parse(range.startDate)
        ? range.startDate
        : row.start_at,
    end_at:
      range.endDate && Date.parse(row.end_at) > Date.parse(range.endDate)
        ? range.endDate
        : row.end_at,
  }));
}

/** 見積もり係数用の期間重複予定。 */
export async function fetchPlansForEstimation(
  supabase: ServiceSupabaseClient,
  userId: string,
  range: DateRangeInput = {},
): Promise<StatPlanRow[]> {
  let query = supabase
    .from('plans')
    .select('id, activity_id, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (range.startDate) query = query.gt('end_at', range.startDate);
  if (range.endDate) query = query.lt('start_at', range.endDate);

  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'statistics',
      operation: 'fetch_plans_for_estimation',
    });
  }
  return (data ?? []).map((row) => ({
    ...row,
    start_at:
      range.startDate && Date.parse(row.start_at) < Date.parse(range.startDate)
        ? range.startDate
        : row.start_at,
    end_at:
      range.endDate && Date.parse(row.end_at) > Date.parse(range.endDate)
        ? range.endDate
        : row.end_at,
  }));
}

export async function fetchActivitiesById(
  supabase: ServiceSupabaseClient,
  userId: string,
): Promise<Map<string, { id: string; name: string; category_id: string | null }>> {
  // is_active / archived_at では絞らない。過去の Plan / Record はアーカイブ済み
  // アクティビティを参照し続けるため、統計・過去表示では元の名前・所属を解決する必要がある（#1576）
  const { data, error } = await supabase
    .from('activities')
    .select('id, name, category_id')
    .eq('user_id', userId);
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'statistics',
      operation: 'fetch_activities',
    });
  }
  return new Map((data ?? []).map((activity) => [activity.id, activity]));
}

export async function fetchCategoriesById(
  supabase: ServiceSupabaseClient,
  userId: string,
): Promise<Map<string, { id: string; name: string; color: string | null; icon: string | null }>> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, color, icon')
    .eq('user_id', userId);
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'statistics',
      operation: 'fetch_categories',
    });
  }
  return new Map((data ?? []).map((category) => [category.id, category]));
}
