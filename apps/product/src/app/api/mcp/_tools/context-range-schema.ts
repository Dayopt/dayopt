import { z } from 'zod';

import { TIMEBLOCK_CONTEXT_MAX_RANGE_MS } from '@/features/timeblock/server/service-index';

import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';

/**
 * tool が広告する入力スキーマ（ZodObject のまま保つ）。
 *
 * **`.superRefine()` を通した値をここへ渡さない。** ZodEffects になると MCP SDK が
 * shape を取り出せず、`tools/list` が `properties: {}`（引数なし）として広告する。
 * client はそれを信じて `{}` で呼び、サーバー側の検証だけが効いて -32602 で落ちる。
 * 2026-09-11 に本番の `review.get` / `constraints.get` がこの状態だった（#2553）。
 *
 * 交差検証（start < end、31 日上限）は下の `MCP_CONTEXT_RANGE_SCHEMA` が持ち、
 * handler が明示的に走らせる。
 */
export const MCP_CONTEXT_RANGE_INPUT_SCHEMA = z
  .object({
    startDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
    endDate: MCP_TIMEBLOCK_TIMESTAMP_SCHEMA,
  })
  .strict();

/** 交差検証まで含む完全な検証。広告には使わず handler の中で使う。 */
export const MCP_CONTEXT_RANGE_SCHEMA = MCP_CONTEXT_RANGE_INPUT_SCHEMA.superRefine(
  (range, context) => {
    const start = Date.parse(range.startDate);
    const end = Date.parse(range.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;

    if (start >= end) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate must be after startDate',
        path: ['endDate'],
      });
      return;
    }

    if (end - start > TIMEBLOCK_CONTEXT_MAX_RANGE_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date range must not exceed 31 days',
        path: ['endDate'],
      });
    }
  },
);
