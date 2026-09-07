import 'server-only';

import { databaseTables, publicRecordSelect } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import { runPrivateTimeblockSearchQuery } from './private-timeblock-search-query';
import { buildTimeblockSearchFilter } from './timeblock-search-query';
import { TimeblockServiceError } from './timeblock-service-error';
import type { GetRecordByIdOptions, ListRecordsOptions, RecordRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

/**
 * Record の read 専用 service。
 *
 * 書き込みは `TimeblockCommandService` -> `TimeblockCommandClient` -> SQL command の
 * 1 経路だけが残っている（#1893 で legacy route と、それを支えていた write method を
 * 削除した）。この service は `recordsRouter` の read と、`TimeblockCommandService` が
 * 更新前の行を読むための `getById` を提供する。
 */
export class RecordService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  async list(options: ListRecordsOptions): Promise<RecordRow[]> {
    const {
      userId,
      activityId,
      planId,
      planIds,
      search,
      startDate,
      endDate,
      sortBy = 'start_at',
      sortOrder = 'desc',
      limit,
      offset,
    } = options;

    if (planIds?.length === 0) return [];

    let query = this.supabase
      .from(databaseTables.records)
      .select(publicRecordSelect)
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (activityId) query = query.eq('activity_id', activityId);
    if (planId) query = query.eq('plan_id', planId);
    if (planIds) query = query.in('plan_id', planIds);

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
        operation: 'list_records',
      });
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch records', {
        cause: original,
      });
    }

    return data ?? [];
  }

  async getById(options: GetRecordByIdOptions): Promise<RecordRow> {
    const { userId, recordId } = options;
    const { data, error } = await this.supabase
      .from(databaseTables.records)
      .select(publicRecordSelect)
      .eq('id', recordId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      const original = captureUnexpectedDatabaseError(error, {
        feature: 'timeblock',
        operation: 'get_record_by_id',
      });
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch record', {
        cause: original,
      });
    }
    if (!data) {
      throw new TimeblockServiceError('NOT_FOUND', 'Record not found');
    }

    return data;
  }
}

export function createRecordService(supabase: ServiceSupabaseClient): RecordService {
  return new RecordService(supabase);
}
