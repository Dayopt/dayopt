import 'server-only';

import { databaseTables } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import {
  readTimeblockContextMarker,
  type TimeblockContextMarker,
} from './timeblock-context-client';
import type { TimeblockContextRange } from './timeblock-context-contract';
import { TimeblockServiceError } from './timeblock-service-error';

type TimeblockReviewLane = 'plans' | 'records';

export interface TimeblockReviewRow {
  id: string;
  /** アクティビティ未設定、および削除で `activity_id = NULL` になった行は null */
  activityId: string | null;
  startAt: string;
  endAt: string;
}

export interface TimeblockReviewPage {
  rows: TimeblockReviewRow[];
  totalCount: number | null;
}

export interface ListTimeblockReviewPageInput extends TimeblockContextRange {
  userId: string;
  lane: TimeblockReviewLane;
  offset: number;
  limit: number;
}

export interface TimeblockReviewReadClient {
  getMarker(userId: string, signal?: AbortSignal): Promise<TimeblockContextMarker>;
  listReviewPage(
    input: ListTimeblockReviewPageInput,
    signal?: AbortSignal,
  ): Promise<TimeblockReviewPage>;
}

/** MCP reviewのservice-role readをverified userと最小projectionへ固定する。 */
class TimeblockReviewClient implements TimeblockReviewReadClient {
  private readonly admin = createServiceRoleClient();

  getMarker(userId: string, signal?: AbortSignal): Promise<TimeblockContextMarker> {
    return readTimeblockContextMarker(this.admin, userId, signal);
  }

  async listReviewPage(
    input: ListTimeblockReviewPageInput,
    signal?: AbortSignal,
  ): Promise<TimeblockReviewPage> {
    const table = input.lane === 'plans' ? databaseTables.plans : databaseTables.records;
    const tableQuery = this.admin.from(table);
    const query =
      input.offset === 0
        ? tableQuery.select('id,activity_id,start_at,end_at', { count: 'exact' })
        : tableQuery.select('id,activity_id,start_at,end_at');
    // activity_id が null の行も読む。アクティビティ削除で Plan / Record は未設定化されるため、
    // 絞ると削除のたびに過去の時間が review から目減りする（#1576）
    query
      .eq('user_id', input.userId)
      .is('deleted_at', null)
      .gt('end_at', input.startDate)
      .lt('start_at', input.endDate)
      .order('start_at', { ascending: true })
      .order('id', { ascending: true })
      .range(input.offset, input.offset + input.limit - 1);
    if (signal) query.abortSignal(signal);

    const { data, error, count } = await query;
    if (error || !data) {
      if (signal?.aborted) {
        throw new TimeblockServiceError('FETCH_FAILED', 'Timeblock review read was interrupted');
      }
      const original = captureUnexpectedDatabaseError(error ?? new Error('Review page missing'), {
        feature: 'timeblock',
        operation: `list_${input.lane}_mcp_review`,
      });
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to read timeblock review rows', {
        cause: original,
      });
    }

    return {
      rows: data.map((row) => ({
        id: row.id,
        activityId: row.activity_id,
        startAt: row.start_at,
        endAt: row.end_at,
      })),
      totalCount: count,
    };
  }
}

export function createTimeblockReviewClient(): TimeblockReviewClient {
  return new TimeblockReviewClient();
}
