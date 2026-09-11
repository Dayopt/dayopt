import 'server-only';

import { logger } from '@/lib/logger';
import { captureUnexpectedMcpToolError } from '@/lib/mcp/tool-error';
import { createMcpTrpcCaller } from '@/lib/mcp/trpc-bridge';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRequestContext } from '../_context';
import { MCP_CONTEXT_RANGE_SCHEMA } from './context-range-schema';
import { findMcpContextReadErrorCode } from './context-read-error';
import { MCP_REVIEW_GET_INPUT_SCHEMA, MCP_REVIEW_GET_OUTPUT_SCHEMA } from './review-contract';
import { createMcpToolError, createMcpToolSuccess, MCP_TOOL_SCHEMA_VERSION } from './tool-result';
import { MCP_UNTRUSTED_CONTENT_NOTICE } from './untrusted-data-serialization';

/** アクティビティなし（activityId null）は常に false。未解決（degrade）の時も false 固定。 */
function resolveIsArchived(
  activityId: string | null,
  archivedActivityIds: Set<string> | null,
): boolean {
  if (activityId === null) return false;
  return archivedActivityIds?.has(activityId) ?? false;
}

export function registerReviewGetTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'review.get',
    {
      title: 'Get Dayopt Plan and Record review',
      description: `Get deterministic Plan versus Record totals, activity variances, and accuracy signals. Totals are broken down by activity, the same one-per-block granularity a Plan or Record carries; resolve activityId through activities.list, and roll up to categories through its categoryId when a coarser view is wanted. Time on blocks with no activity is included as a single row with activityId null and isNoActivity true, so totals cover every block in the period. Activity rows and the largest_activity_variance signal also carry isArchived, true only when that activityId can no longer be assigned to new Plans or Records; its past time still counts in these totals. isArchived safely defaults to false when archived status cannot be resolved. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_REVIEW_GET_INPUT_SCHEMA,
      outputSchema: MCP_REVIEW_GET_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input, extra) => {
      if (!ctx.scopes.includes('read:stats')) {
        return createMcpToolError(
          'INSUFFICIENT_SCOPE',
          'This connection does not have access to Dayopt review statistics.',
        );
      }

      // 交差検証（start < end、31 日上限）は広告用 schema から外してあるため、
      // ここで明示的に走らせる。tRPC 側の `timeblockContextRangeSchema` も同じ規則を
      // 持つが、そちらへ落とすと client の入力ミスが zod error として
      // `captureUnexpectedMcpToolError` に乗り、Sentry の予期せぬ失敗として積まれる。
      const range = MCP_CONTEXT_RANGE_SCHEMA.safeParse(input);
      if (!range.success) {
        return createMcpToolError(
          'INVALID_RANGE',
          range.error.issues[0]?.message ?? 'Invalid date range.',
        );
      }

      try {
        const trpc = createMcpTrpcCaller({
          userId: ctx.userId,
          clientId: ctx.clientId,
          scopes: ctx.scopes,
          signal: extra.signal,
        });

        // アーカイブ判定は review 本体と切り離して失敗させる。`read:activities` scope が
        // 無い接続や activities.list 側の一時的な失敗で review.get 全体を落とさない。
        // 失敗時は null (= 全行 isArchived false) に degrade する。誤判定の向きは常に
        // 安全側（非archivedをarchivedと誤表示することはなく、archivedの見落としのみ）。
        //
        // **`archived_at != null` での絞り込みが必須。** 旧 `tags.listArchived` は
        // アーカイブ済みのみを返したが、`listActivities({ includeArchived: true })` は
        // アクティブも含む全件を返す。素直に全件を Set へ入れると全アクティビティが
        // archived 扱いになり、degrade の向きが安全側から危険側へ反転する。
        const resolveArchivedActivityIds = async (): Promise<Set<string> | null> => {
          // `read:activities` を持たない接続（`read:stats` のみ等）では呼んでも必ず
          // scope 拒否になる。往復と warn を無駄に出さず、想定内の欠落として即 degrade する。
          if (!ctx.scopes.includes('read:activities')) return null;
          try {
            const activities = await trpc.activities.listActivities({ includeArchived: true });
            return new Set(
              activities
                .filter((activity) => activity.archived_at !== null)
                .map((activity) => activity.id),
            );
          } catch (error) {
            captureUnexpectedMcpToolError(error, 'review_get_archived_activities');
            logger.warn(
              'MCP review get could not resolve archived activities; isArchived defaults to false',
            );
            return null;
          }
        };

        const [result, archivedActivityIds] = await Promise.all([
          trpc.statistics.getMcpReview(range.data),
          resolveArchivedActivityIds(),
        ]);

        return createMcpToolSuccess({
          schemaVersion: MCP_TOOL_SCHEMA_VERSION,
          asOf: result.asOf,
          period: {
            startDate: result.period.startDate,
            endDate: result.period.endDate,
            endExclusive: result.period.endExclusive,
            timezone: result.period.timezone,
          },
          basis: {
            planMeaning: result.basis.planMeaning,
            recordMeaning: result.basis.recordMeaning,
            rowFilter: result.basis.rowFilter,
            durationBoundary: result.basis.durationBoundary,
            periodBoundary: result.basis.periodBoundary,
            varianceConvention: result.basis.varianceConvention,
          },
          hasData: result.hasData,
          summary: {
            plannedMinutes: result.summary.plannedMinutes,
            recordedMinutes: result.summary.recordedMinutes,
            varianceMinutes: result.summary.varianceMinutes,
          },
          accuracy: result.accuracy
            ? {
                rate: result.accuracy.rate,
                status: result.accuracy.status,
              }
            : null,
          activities: result.activities.map((activity) => ({
            activityId: activity.activityId,
            isNoActivity: activity.isNoActivity,
            isArchived: resolveIsArchived(activity.activityId, archivedActivityIds),
            plannedMinutes: activity.plannedMinutes,
            recordedMinutes: activity.recordedMinutes,
            varianceMinutes: activity.varianceMinutes,
            variancePercent: activity.variancePercent,
          })),
          signals: result.signals.map((signal) =>
            signal.code === 'plan_accuracy'
              ? {
                  code: signal.code,
                  rate: signal.rate,
                  status: signal.status,
                }
              : {
                  code: signal.code,
                  activityId: signal.activityId,
                  isNoActivity: signal.isNoActivity,
                  isArchived: resolveIsArchived(signal.activityId, archivedActivityIds),
                  direction: signal.direction,
                  absoluteMinutes: signal.absoluteMinutes,
                },
          ),
        });
      } catch (error) {
        const contextCode = findMcpContextReadErrorCode(error);
        if (contextCode === 'RANGE_TOO_DENSE') {
          return createMcpToolError(
            'RANGE_TOO_DENSE',
            'This range contains too many items. Use a narrower range.',
          );
        }
        if (contextCode === 'CONTEXT_CHANGED') {
          return createMcpToolError(
            'CONTEXT_CHANGED',
            'Dayopt data changed during the read. Please try again.',
            true,
          );
        }
        if (contextCode !== 'REQUEST_CANCELLED') {
          captureUnexpectedMcpToolError(error, 'review_get');
          logger.error('MCP review get failed');
        }
        return createMcpToolError('READ_FAILED', 'Review statistics could not be loaded.', true);
      }
    },
  );
}
