import 'server-only';

import { z } from 'zod';

import { logger } from '@/lib/logger';
import { captureUnexpectedMcpToolError } from '@/lib/mcp/tool-error';
import { createMcpTrpcCaller } from '@/lib/mcp/trpc-bridge';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRequestContext } from '../_context';
import { MCP_ENTRY_LIST_OUTPUT_SCHEMA } from './timeblock-contract';
import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';
import { createMcpToolError, createMcpToolSuccess, MCP_TOOL_SCHEMA_VERSION } from './tool-result';
import { MCP_UNTRUSTED_CONTENT_NOTICE } from './untrusted-data-serialization';

/**
 * `entries.list` tool — Dayopt entries (timeboxes / records) を取得する。
 *
 * Step 8 以降の互換 tool。`createMcpTrpcCaller` 経由で plans / records の read procedure
 * を呼び、従来の entry 形式へ合成して返す。
 */

/**
 * 範囲フィルターの意味と受理集合は `plans.list` / `records.list` と同じ（#2721 D-03 / D-04）。
 * 実 service は両端指定時だけ半開区間との重なりで絞り、片側指定ではその端を `start_at`
 * に当てる。
 */
export const MCP_ENTRY_LIST_INPUT_SCHEMA = z
  .object({
    startDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA.optional().describe(
      'ISO 8601 date-time with a UTC offset. With endDate: returns entries overlapping the half-open range [startDate, endDate). Alone: returns entries whose startTime >= startDate. Results are capped by limit (newest first), so a dense range can return fewer entries than it contains.',
    ),
    endDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA.optional().describe(
      'ISO 8601 date-time with a UTC offset. With startDate: see startDate. Alone: returns entries whose startTime <= endDate.',
    ),
    activityId: z.string().uuid().optional().describe('Filter by activity UUID.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Max entries to return, newest first. Defaults to 50, max 100. Truncation is silent: a full result is not signalled.',
      ),
  })
  .strict();

interface NormalizedEntry {
  id: string;
  title: string;
  description: string | null;
  origin: string;
  startTime: string | null;
  endTime: string | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  durationMinutes: number | null;
  activityId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EntryRowLike {
  id: string;
  title: string;
  description: string | null;
  origin: string;
  start_time: string | null;
  end_time: string | null;
  actual_start_time: string | null;
  actual_end_time: string | null;
  planned_duration_minutes: number | null;
  activity_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function durationMinutes(startTime: string, endTime: string): number {
  return Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60_000);
}

export function registerEntriesListTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'entries.list',
    {
      title: 'List Dayopt entries',
      description: `List the authenticated user's Dayopt entries (timeboxes / records). Read-only. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_ENTRY_LIST_INPUT_SCHEMA,
      outputSchema: MCP_ENTRY_LIST_OUTPUT_SCHEMA,
    },
    async ({ startDate, endDate, activityId, limit }) => {
      // Scope enforcement: token が read:entries を持たない場合は実行しない
      if (!ctx.scopes.includes('read:entries')) {
        return createMcpToolError(
          'INSUFFICIENT_SCOPE',
          'Access denied: this token does not have the read:entries scope.',
        );
      }
      try {
        const trpc = createMcpTrpcCaller({
          userId: ctx.userId,
          clientId: ctx.clientId,
          scopes: ctx.scopes,
        });
        const [plans, records] = await Promise.all([
          trpc.plans.list({
            limit: limit ?? 50,
            sortBy: 'start_at',
            sortOrder: 'desc',
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
            ...(activityId ? { activityId } : {}),
          }),
          trpc.records.list({
            limit: limit ?? 50,
            sortBy: 'start_at',
            sortOrder: 'desc',
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
            ...(activityId ? { activityId } : {}),
          }),
        ]);
        const entries: EntryRowLike[] = [
          ...plans.map((plan) => ({
            id: plan.id,
            title: plan.title,
            description: plan.note,
            origin: 'planned',
            start_time: plan.start_at,
            end_time: plan.end_at,
            actual_start_time: null,
            actual_end_time: null,
            planned_duration_minutes: durationMinutes(plan.start_at, plan.end_at),
            activity_id: plan.activity_id,
            created_at: plan.created_at,
            updated_at: plan.updated_at,
          })),
          ...records.map((record) => ({
            id: record.id,
            title: record.title,
            description: record.note,
            origin: 'unplanned',
            start_time: record.start_at,
            end_time: record.end_at,
            actual_start_time: record.start_at,
            actual_end_time: record.end_at,
            planned_duration_minutes: null,
            activity_id: record.activity_id,
            created_at: record.created_at,
            updated_at: record.updated_at,
          })),
        ]
          .sort((a, b) => (b.start_time ?? '').localeCompare(a.start_time ?? ''))
          .slice(0, limit ?? 50);

        const normalized = entries.map(normalizeEntry);
        return createMcpToolSuccess({
          schemaVersion: MCP_TOOL_SCHEMA_VERSION,
          count: normalized.length,
          entries: normalized,
        });
      } catch (err) {
        captureUnexpectedMcpToolError(err, 'entries_list');
        logger.error('MCP entries list failed');
        return createMcpToolError('READ_FAILED', 'Failed to list entries. Please try again.', true);
      }
    },
  );
}

function normalizeEntry(e: EntryRowLike): NormalizedEntry {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    origin: e.origin,
    startTime: e.start_time,
    endTime: e.end_time,
    actualStartTime: e.actual_start_time,
    actualEndTime: e.actual_end_time,
    durationMinutes: e.planned_duration_minutes,
    activityId: e.activity_id,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}
