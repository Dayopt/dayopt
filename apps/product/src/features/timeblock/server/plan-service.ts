import 'server-only';

import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import { runPrivateTimeblockSearchQuery } from './private-timeblock-search-query';
import { buildTimeblockSearchFilter } from './timeblock-search-query';
import { TimeblockServiceError } from './timeblock-service-error';
import type { GetPlanByIdOptions, ListPlansOptions, PlanRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

/**
 * Plan の read 専用 service。
 *
 * 書き込みは `TimeblockCommandService` -> `TimeblockCommandClient` -> SQL command の
 * 1 経路だけが残っている（#1893 で legacy route と、それを支えていた write method を
 * 削除した）。この service は `plansRouter` の read と、`TimeblockCommandService` が
 * 更新前の行を読むための `getById` を提供する。
 */
export class PlanService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  async list(options: ListPlansOptions): Promise<PlanRow[]> {
    const {
      userId,
      ids,
      activityId,
      search,
      startDate,
      endDate,
      includeSkipped = true,
      sortBy = 'start_at',
      sortOrder = 'asc',
      limit,
      offset,
    } = options;

    if (ids?.length === 0) return [];

    let query = this.supabase
      .from('plans')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (ids) query = query.in('id', ids);
    if (activityId) query = query.eq('activity_id', activityId);
    if (!includeSkipped) query = query.is('skipped_at', null);

    if (search) {
      const searchFilter = await buildTimeblockSearchFilter({
        supabase: this.supabase,
        userId,
        search,
      });
      query = query.or(searchFilter);
    }

    if (startDate && endDate) {
      query = query.lt('start_at', endDate).gt('end_at', startDate);
    } else if (startDate) {
      query = query.gte('start_at', startDate);
    } else if (endDate) {
      query = query.lte('start_at', endDate);
    }

    query = query.order(sortBy, { ascending: sortOrder === 'asc' });

    if (limit) query = query.limit(limit);
    if (offset) query = query.range(offset, offset + (limit ?? 100) - 1);

    const { data, error } = search
      ? await runPrivateTimeblockSearchQuery(() => query)
      : await query;

    if (error) {
      const original = captureUnexpectedDatabaseError(error, {
        feature: 'timeblock',
        operation: 'list_plans',
      });
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch plans', {
        cause: original,
      });
    }

    return data ?? [];
  }

  async getById(options: GetPlanByIdOptions): Promise<PlanRow> {
    const { userId, planId } = options;
    const { data, error } = await this.supabase
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      const original = captureUnexpectedDatabaseError(error, {
        feature: 'timeblock',
        operation: 'get_plan_by_id',
      });
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch plan', {
        cause: original,
      });
    }
    if (!data) {
      throw new TimeblockServiceError('NOT_FOUND', 'Plan not found');
    }

    return data;
  }
}

export function createPlanService(supabase: ServiceSupabaseClient): PlanService {
  return new PlanService(supabase);
}
