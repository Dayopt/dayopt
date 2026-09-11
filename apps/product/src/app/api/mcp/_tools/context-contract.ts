import { z } from 'zod';

import { MCP_CONTEXT_RANGE_INPUT_SCHEMA } from './context-range-schema';
import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';
import { MCP_TOOL_SCHEMA_VERSION } from './tool-result';

const MCP_OCCUPANCY_SCHEMA = z
  .object({
    startAt: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
    endAt: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
  })
  .strict();

// 既定は false のまま。既定でアーカイブ済みを混ぜると、新規付与の候補として
// 選ばれてサービス層の `ACTIVITY_ARCHIVED` で弾かれる無駄な試行が増える。
const MCP_ARCHIVE_FILTER_INPUT_SCHEMA = z
  .object({
    includeArchived: z.boolean().default(false),
  })
  .strict();

// includeArchived の値によらず常に返す 2 field。false / null 固定になる既定応答でも
// 行の形を変えないことで、client 側の解釈を 1 通りに保つ。
//
// archivedAt は「passthrough な nullable audit timestamp」なので plain string を使う
// （timeblock-contract.ts の deletedAt と同じ流儀。MCP_TIMEBLOCK_TIMESTAMP_SCHEMA は
// 境界演算に使う入力/契約用の厳密書式で、DB 値をそのまま返す出力専用 field には使わない）。
const MCP_ARCHIVE_STATE_FIELDS = {
  isArchived: z.boolean(),
  archivedAt: z.string().nullable(),
} as const;

export const MCP_ACTIVITY_LIST_INPUT_SCHEMA = MCP_ARCHIVE_FILTER_INPUT_SCHEMA;

export const MCP_ACTIVITY_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    activities: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          // 所属カテゴリー。null = 未分類。アクティビティは色もアイコンも持たず、
          // 表示色はカテゴリーから継承するので、client は categories.list と
          // この id で突き合わせる。
          categoryId: z.string().uuid().nullable(),
          ...MCP_ARCHIVE_STATE_FIELDS,
        })
        .strict(),
    ),
  })
  .strict();

export const MCP_CATEGORY_LIST_INPUT_SCHEMA = MCP_ARCHIVE_FILTER_INPUT_SCHEMA;

export const MCP_CATEGORY_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    categories: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          color: z.string().nullable(),
          icon: z.string().nullable(),
          ...MCP_ARCHIVE_STATE_FIELDS,
        })
        .strict(),
    ),
  })
  .strict();

export const MCP_CONSTRAINTS_GET_INPUT_SCHEMA = MCP_CONTEXT_RANGE_INPUT_SCHEMA;

export const MCP_CONSTRAINTS_GET_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    asOf: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
    timezone: z.string().min(1),
    range: z
      .object({
        startDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
        endDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
        endExclusive: z.literal(true),
      })
      .strict(),
    completeness: z
      .object({
        complete: z.literal(true),
        maxItemsPerLane: z.literal(5_000),
      })
      .strict(),
    occupancy: z
      .object({
        plans: z.array(MCP_OCCUPANCY_SCHEMA),
        records: z.array(MCP_OCCUPANCY_SCHEMA),
      })
      .strict(),
    rules: z
      .object({
        intervalBoundary: z.literal('[)'),
        overlap: z
          .object({
            planVsPlan: z.literal('forbidden'),
            recordVsRecord: z.literal('forbidden'),
            planVsRecord: z.literal('allowed'),
          })
          .strict(),
        plans: z
          .object({
            createEnd: z.literal('unrestricted'),
            pastPlanTimeUpdate: z.literal('allowed'),
            pastPlanContentUpdate: z.literal('allowed'),
            timeUpdateEnd: z.literal('unrestricted'),
          })
          .strict(),
        records: z
          .object({
            createEnd: z.literal('at_or_before_as_of'),
            timeUpdateEnd: z.literal('at_or_before_as_of'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * セグメント（分析用の保存されたクエリ）の一覧。
 *
 * アーカイブ概念を持たないので archive filter を取らない（segments テーブルに
 * archived_at が無い。#2162 §4-3）。セグメントは軽量な保存クエリなので、
 * アーカイブではなく削除で足りるという設計判断。
 */
export const MCP_SEGMENT_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    segments: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          // セグメントが保持するのはアクティビティの集合だけ。期間・指標・並べ替えは
          // 持たない（#2162 §6-4。レポートビルダー化を構造で防ぐ）。
          activityIds: z.array(z.string().uuid()),
        })
        .strict(),
    ),
  })
  .strict();
