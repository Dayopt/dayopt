import { z } from 'zod';

import { TIMEBLOCK_REVIEW_MAX_ACTIVITIES } from '@/features/timeblock/server/service-index';

import { MCP_CONTEXT_RANGE_INPUT_SCHEMA } from './context-range-schema';
import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';
import { MCP_TOOL_SCHEMA_VERSION } from './tool-result';

export const MCP_REVIEW_GET_INPUT_SCHEMA = MCP_CONTEXT_RANGE_INPUT_SCHEMA;

const MCP_REVIEW_ACCURACY_STATUS_SCHEMA = z.enum(['excellent', 'good', 'fair', 'poor']);

export const MCP_REVIEW_GET_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    asOf: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
    period: z
      .object({
        startDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
        endDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
        endExclusive: z.literal(true),
        timezone: z.string().min(1),
      })
      .strict(),
    basis: z
      .object({
        planMeaning: z.literal('budget'),
        recordMeaning: z.literal('actual'),
        rowFilter: z.literal('active_overlapping_period'),
        durationBoundary: z.literal('clipped_to_period'),
        periodBoundary: z.literal('[)'),
        varianceConvention: z.literal('planned_minus_recorded'),
      })
      .strict(),
    hasData: z.boolean(),
    summary: z
      .object({
        plannedMinutes: z.number().nonnegative(),
        recordedMinutes: z.number().nonnegative(),
        varianceMinutes: z.number(),
      })
      .strict(),
    accuracy: z
      .object({
        rate: z.number().min(0).max(1),
        status: MCP_REVIEW_ACCURACY_STATUS_SCHEMA,
      })
      .strict()
      .nullable(),
    // アクティビティ未設定のブロックは activityId: null / isNoActivity: true の 1 行と
    // して返る。client が解決できない activityId と「アクティビティなし」を取り違え
    // ないよう、後者は明示 flag で識別できる形にする。
    //
    // 軸はアクティビティ（旧タグと同じ「1 ブロック 1 つ」の粒度）。カテゴリー別の
    // 合計が要る client は activities.list の categoryId で畳める。逆にカテゴリーで
    // 返すと client 側から細分化へ戻せないため、粒度の細かい側で出す（#2162）。
    //
    // isArchived は「確実に archived」という肯定シグナルとしてだけ扱い、false を
    // 「確実に非 archived」とは解釈しない（#1576）。解決元は #2174 で `read:tags` が
    // 廃止された後、#2173 で activities.list（archived_at != null）へ移した。
    activities: z
      .array(
        z
          .object({
            activityId: z.string().uuid().nullable(),
            isNoActivity: z.boolean(),
            isArchived: z.boolean(),
            plannedMinutes: z.number().nonnegative(),
            recordedMinutes: z.number().nonnegative(),
            varianceMinutes: z.number(),
            variancePercent: z.number().int().nullable(),
          })
          .strict(),
      )
      .max(TIMEBLOCK_REVIEW_MAX_ACTIVITIES),
    signals: z.array(
      z.discriminatedUnion('code', [
        z
          .object({
            code: z.literal('plan_accuracy'),
            rate: z.number().min(0).max(1),
            status: MCP_REVIEW_ACCURACY_STATUS_SCHEMA,
          })
          .strict(),
        z
          .object({
            code: z.literal('largest_activity_variance'),
            activityId: z.string().uuid().nullable(),
            isNoActivity: z.boolean(),
            // activities[] の同じ activityId と判定を一貫させる（同じ resolveIsArchived を通す）。
            isArchived: z.boolean(),
            direction: z.enum(['recorded_less_than_planned', 'recorded_more_than_planned']),
            absoluteMinutes: z.number().positive(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
