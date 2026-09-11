import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  MCP_ACTIVITY_LIST_INPUT_SCHEMA,
  MCP_ACTIVITY_LIST_OUTPUT_SCHEMA,
  MCP_CATEGORY_LIST_INPUT_SCHEMA,
  MCP_CATEGORY_LIST_OUTPUT_SCHEMA,
  MCP_CONSTRAINTS_GET_INPUT_SCHEMA,
  MCP_CONSTRAINTS_GET_OUTPUT_SCHEMA,
  MCP_SEGMENT_LIST_OUTPUT_SCHEMA,
} from './context-contract';
import { MCP_ENTRY_LIST_INPUT_SCHEMA } from './entries-list';
import { MCP_REVIEW_GET_INPUT_SCHEMA, MCP_REVIEW_GET_OUTPUT_SCHEMA } from './review-contract';
import {
  MCP_ENTRY_LIST_OUTPUT_SCHEMA,
  MCP_PLAN_GET_OUTPUT_SCHEMA,
  MCP_PLAN_LIST_OUTPUT_SCHEMA,
  MCP_RECORD_GET_OUTPUT_SCHEMA,
  MCP_RECORD_LIST_OUTPUT_SCHEMA,
} from './timeblock-contract';
import {
  MCP_PLAN_GET_INPUT_SCHEMA,
  MCP_RECORD_GET_INPUT_SCHEMA,
  MCP_TRASH_LIST_INPUT_SCHEMA,
} from './timeblock-detail';
import { MCP_TIMEBLOCK_LIST_INPUT_SCHEMA } from './timeblock-list';
import {
  MCP_PLAN_ACTIVE_RECEIPT_SCHEMA,
  MCP_PLAN_CREATE_INPUT_SCHEMA,
  MCP_PLAN_DELETED_RECEIPT_SCHEMA,
  MCP_PLAN_UPDATE_INPUT_SCHEMA,
  MCP_PLAN_VERSIONED_INPUT_SCHEMA,
  MCP_RECORD_ACTIVE_RECEIPT_SCHEMA,
  MCP_RECORD_CREATE_INPUT_SCHEMA,
  MCP_RECORD_DELETED_RECEIPT_SCHEMA,
  MCP_RECORD_UPDATE_INPUT_SCHEMA,
  MCP_RECORD_VERSIONED_INPUT_SCHEMA,
} from './timeblock-mutations';

/**
 * MCP tool の zod contract を JSON Schema へ変換し snapshot する（#2596）。
 *
 * Codex クロスレビューが手動で見ていた「MCP の外部契約を壊れる形で変更していないか」
 * （CODEX-3）を、決定的な snapshot diff として CI に出す。field 削除・型変更・enum
 * 縮小はすべて snapshot の diff として現れる。意図した変更なら
 * `pnpm --filter @dayopt/product vitest run -u` で snapshot を更新し、
 * 破壊的変更なら `MCP_TOOL_SCHEMA_VERSION`（./tool-result.ts）を bump したか、
 * 既存 consumer への影響を確認すること。
 */
const CONTRACTS = {
  activityListInput: MCP_ACTIVITY_LIST_INPUT_SCHEMA,
  activityListOutput: MCP_ACTIVITY_LIST_OUTPUT_SCHEMA,
  categoryListInput: MCP_CATEGORY_LIST_INPUT_SCHEMA,
  categoryListOutput: MCP_CATEGORY_LIST_OUTPUT_SCHEMA,
  constraintsGetInput: MCP_CONSTRAINTS_GET_INPUT_SCHEMA,
  constraintsGetOutput: MCP_CONSTRAINTS_GET_OUTPUT_SCHEMA,
  segmentListOutput: MCP_SEGMENT_LIST_OUTPUT_SCHEMA,
  reviewGetInput: MCP_REVIEW_GET_INPUT_SCHEMA,
  reviewGetOutput: MCP_REVIEW_GET_OUTPUT_SCHEMA,
  planListOutput: MCP_PLAN_LIST_OUTPUT_SCHEMA,
  planGetOutput: MCP_PLAN_GET_OUTPUT_SCHEMA,
  recordListOutput: MCP_RECORD_LIST_OUTPUT_SCHEMA,
  recordGetOutput: MCP_RECORD_GET_OUTPUT_SCHEMA,
  entryListOutput: MCP_ENTRY_LIST_OUTPUT_SCHEMA,
  // 入力側（#2721 D-05）。広告される引数の削除・型変更・enum 縮小も diff に出す。
  entryListInput: MCP_ENTRY_LIST_INPUT_SCHEMA,
  timeblockListInput: MCP_TIMEBLOCK_LIST_INPUT_SCHEMA,
  planGetInput: MCP_PLAN_GET_INPUT_SCHEMA,
  recordGetInput: MCP_RECORD_GET_INPUT_SCHEMA,
  trashListInput: MCP_TRASH_LIST_INPUT_SCHEMA,
  // mutation の入出力（#2721 D-05）。write gate が開く前に固定しておく。
  planCreateInput: MCP_PLAN_CREATE_INPUT_SCHEMA,
  planUpdateInput: MCP_PLAN_UPDATE_INPUT_SCHEMA,
  planVersionedInput: MCP_PLAN_VERSIONED_INPUT_SCHEMA,
  recordCreateInput: MCP_RECORD_CREATE_INPUT_SCHEMA,
  recordUpdateInput: MCP_RECORD_UPDATE_INPUT_SCHEMA,
  recordVersionedInput: MCP_RECORD_VERSIONED_INPUT_SCHEMA,
  planActiveReceipt: MCP_PLAN_ACTIVE_RECEIPT_SCHEMA,
  planDeletedReceipt: MCP_PLAN_DELETED_RECEIPT_SCHEMA,
  recordActiveReceipt: MCP_RECORD_ACTIVE_RECEIPT_SCHEMA,
  recordDeletedReceipt: MCP_RECORD_DELETED_RECEIPT_SCHEMA,
} as const;

describe('MCP tool contract snapshot', () => {
  for (const [name, schema] of Object.entries(CONTRACTS)) {
    it(`${name} の JSON Schema が変わっていない`, () => {
      const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
      const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
      expect(rest).toMatchSnapshot();
    });
  }
});
