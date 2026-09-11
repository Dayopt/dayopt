import 'server-only';

import { z } from 'zod';

import {
  transformPlanReadModel,
  transformRecordReadModel,
} from '@/features/timeblock/server/service-index';
import { logger } from '@/lib/logger';
import { captureUnexpectedMcpToolError } from '@/lib/mcp/tool-error';
import { createMcpTrpcCaller } from '@/lib/mcp/trpc-bridge';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRequestContext } from '../_context';
import { MCP_PLAN_LIST_OUTPUT_SCHEMA, MCP_RECORD_LIST_OUTPUT_SCHEMA } from './timeblock-contract';
import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';
import { createMcpToolError, createMcpToolSuccess, MCP_TOOL_SCHEMA_VERSION } from './tool-result';
import { MCP_UNTRUSTED_CONTENT_NOTICE } from './untrusted-data-serialization';

/**
 * 範囲フィルターの意味。service 側（`plan-service.ts` / `record-service.ts` の `list`）は
 * **両端を渡された時だけ** 半開区間との重なりで絞り、片側だけならその端を `start_at` に
 * 当てる。この非対称を description に書かないと、client が日ごとに範囲を切って
 * duration を合算した時に日跨ぎの block を二重計上する（#2721 D-03、V-3 で再現）。
 */
export const MCP_TIMEBLOCK_RANGE_START_DESCRIPTION =
  'ISO 8601 date-time with a UTC offset. With endDate: returns blocks overlapping the half-open range [startDate, endDate). Alone: returns blocks whose startAt >= startDate.';
export const MCP_TIMEBLOCK_RANGE_END_DESCRIPTION =
  'ISO 8601 date-time with a UTC offset. With startDate: see startDate. Alone: returns blocks whose startAt <= endDate.';

/**
 * 範囲入力は他の read tool（`constraints.get` / `review.get`）と同じ
 * `MCP_TIMEBLOCK_TIMESTAMP_SCHEMA` を使う。`z.string().datetime()` のままだと
 * UTC `Z` しか受け付けず、同じ文字列が tool によって通ったり -32602 になったりする
 * （#2721 D-04、V-4 で再現）。
 */
export const MCP_TIMEBLOCK_LIST_INPUT_SCHEMA = z
  .object({
    startDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA.optional().describe(
      MCP_TIMEBLOCK_RANGE_START_DESCRIPTION,
    ),
    endDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA.optional().describe(
      MCP_TIMEBLOCK_RANGE_END_DESCRIPTION,
    ),
    activityId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Step 8: Plan / Record を個別に公開する。entries.list は互換のため残す。 */
export function registerPlansListTool(server: McpServer, ctx: McpRequestContext) {
  registerTimeblockListTool(server, ctx, 'plans');
}

export function registerRecordsListTool(server: McpServer, ctx: McpRequestContext) {
  registerTimeblockListTool(server, ctx, 'records');
}

function registerTimeblockListTool(
  server: McpServer,
  ctx: McpRequestContext,
  model: 'plans' | 'records',
) {
  server.registerTool(
    `${model}.list`,
    {
      title: `List Dayopt ${model}`,
      description: `List authenticated user's ${model}. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_TIMEBLOCK_LIST_INPUT_SCHEMA,
      outputSchema: model === 'plans' ? MCP_PLAN_LIST_OUTPUT_SCHEMA : MCP_RECORD_LIST_OUTPUT_SCHEMA,
    },
    async ({ startDate, endDate, activityId, limit }) => {
      if (!ctx.scopes.includes('read:entries')) {
        return createMcpToolError(
          'INSUFFICIENT_SCOPE',
          'This connection does not have read access to Dayopt entries.',
        );
      }
      try {
        const trpc = createMcpTrpcCaller({
          userId: ctx.userId,
          clientId: ctx.clientId,
          scopes: ctx.scopes,
        });
        const input = {
          limit: limit ?? 50,
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(activityId ? { activityId } : {}),
        };
        if (model === 'plans') {
          const rows = await trpc.plans.list({
            ...input,
            sortBy: 'start_at',
            sortOrder: 'desc',
          });
          const plans = rows.map(transformPlanReadModel);
          return createMcpToolSuccess({
            schemaVersion: MCP_TOOL_SCHEMA_VERSION,
            count: plans.length,
            plans,
          });
        }

        const rows = await trpc.records.list({
          ...input,
          sortBy: 'start_at',
          sortOrder: 'desc',
        });
        const records = rows.map(transformRecordReadModel);
        return createMcpToolSuccess({
          schemaVersion: MCP_TOOL_SCHEMA_VERSION,
          count: records.length,
          records,
        });
      } catch (error) {
        captureUnexpectedMcpToolError(error, `${model}_list`);
        logger.error(`MCP ${model} list failed`);
        return createMcpToolError(
          'READ_FAILED',
          `Failed to list ${model}. Please try again.`,
          true,
        );
      }
    },
  );
}
