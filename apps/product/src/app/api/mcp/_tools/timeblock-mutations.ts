import 'server-only';

import { z } from 'zod';

import {
  MCP_MUTATION_RECEIPT_SCHEMA_VERSION,
  McpMutationClient,
  McpMutationError,
  type McpMutationErrorCode,
} from '@/features/timeblock/server/service-index';
import { logger } from '@/lib/logger';
import { captureUnexpectedMcpToolError } from '@/lib/mcp/tool-error';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpRequestContext } from '../_context';
import { MCP_TIMEBLOCK_TIMESTAMP_SCHEMA } from './timeblock-timestamp-schema';
import { createMcpToolError, createMcpToolSuccess } from './tool-result';

const operationIdSchema = z.string().uuid();
const resourceIdSchema = z.string().uuid();
const timestampSchema = MCP_TIMEBLOCK_TIMESTAMP_SCHEMA;
const titleSchema = z.string().min(1).max(200);
const noteSchema = z.string().max(10_000).nullable().optional();
const nullableIdSchema = z.string().uuid().nullable().optional();
const fulfillmentCreateSchema = z
  .enum(['low', 'medium', 'high'])
  .nullable()
  .optional()
  .describe(
    'Subjective fulfillment felt during this Record: low, medium, or high. Optional; omit or pass null to leave it unrated.',
  );
const fulfillmentUpdateSchema = z
  .enum(['low', 'medium', 'high'])
  .nullable()
  .optional()
  .describe(
    'Subjective fulfillment felt during this Record: low, medium, or high. Omitting this field leaves the existing rating unchanged; pass null explicitly to clear it.',
  );

export const MCP_PLAN_CREATE_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    title: titleSchema,
    note: noteSchema,
    activityId: nullableIdSchema,
    startAt: timestampSchema,
    endAt: timestampSchema,
  })
  .strict();

export const MCP_PLAN_UPDATE_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    planId: resourceIdSchema,
    expectedUpdatedAt: timestampSchema,
    title: titleSchema.optional(),
    note: noteSchema,
    activityId: nullableIdSchema,
    startAt: timestampSchema.optional(),
    endAt: timestampSchema.optional(),
  })
  .strict();

export const MCP_PLAN_VERSIONED_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    planId: resourceIdSchema,
    expectedUpdatedAt: timestampSchema,
  })
  .strict();

export const MCP_RECORD_CREATE_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    title: titleSchema,
    note: noteSchema,
    activityId: nullableIdSchema,
    planId: resourceIdSchema
      .nullable()
      .optional()
      .describe(
        'Deprecated compatibility input. Omit for new Records. A UUID is accepted only so an already-completed legacy operationId can replay; a new operation is rejected.',
      ),
    startAt: timestampSchema,
    endAt: timestampSchema,
    fulfillment: fulfillmentCreateSchema,
  })
  .strict();

export const MCP_RECORD_UPDATE_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    recordId: resourceIdSchema,
    expectedUpdatedAt: timestampSchema,
    title: titleSchema.optional(),
    note: noteSchema,
    activityId: nullableIdSchema,
    startAt: timestampSchema.optional(),
    endAt: timestampSchema.optional(),
    fulfillment: fulfillmentUpdateSchema,
  })
  .strict();

export const MCP_RECORD_VERSIONED_INPUT_SCHEMA = z
  .object({
    operationId: operationIdSchema,
    recordId: resourceIdSchema,
    expectedUpdatedAt: timestampSchema,
  })
  .strict();

function mutationReceiptOutputSchema(resourceType: 'plan' | 'record', deleted: boolean) {
  return z
    .object({
      // mutation receipt の schemaVersion は読み取り tool の MCP_TOOL_SCHEMA_VERSION とは
      // 別系統。DB (mcp_mutation_receipts.envelope_version) に冪等性 replay 用として
      // 永続化された値を apply RPC (apply_mcp_*_v1) がそのまま返すため、
      // MCP_TOOL_SCHEMA_VERSION を上げても DB 側は追従しない。ここで
      // MCP_TOOL_SCHEMA_VERSION を使うと SDK の outputSchema 検証が実際の DB 返却値と
      // 食い違い、全 mutation tool が壊れる。
      schemaVersion: z.literal(MCP_MUTATION_RECEIPT_SCHEMA_VERSION),
      operationId: operationIdSchema,
      resourceType: z.literal(resourceType),
      resourceId: resourceIdSchema,
      version: z.string(),
      deletedAt: deleted ? z.string() : z.null(),
      replayed: z.boolean(),
    })
    .strict();
}

export const MCP_PLAN_ACTIVE_RECEIPT_SCHEMA = mutationReceiptOutputSchema('plan', false);
export const MCP_PLAN_DELETED_RECEIPT_SCHEMA = mutationReceiptOutputSchema('plan', true);
export const MCP_RECORD_ACTIVE_RECEIPT_SCHEMA = mutationReceiptOutputSchema('record', false);
export const MCP_RECORD_DELETED_RECEIPT_SCHEMA = mutationReceiptOutputSchema('record', true);

export function registerPlansCreateTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.create',
    {
      title: 'Create a Dayopt plan',
      description: 'Create one future Plan as canonical Dayopt data.',
      inputSchema: MCP_PLAN_CREATE_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('write:plans')) return insufficientScopeResult();
      return handleMutation('plans_create', () =>
        new McpMutationClient().createPlan({
          ...input,
          note: input.note ?? null,
          activityId: input.activityId ?? null,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerPlansUpdateTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.update',
    {
      title: 'Update a Dayopt plan',
      description: 'Update one active Plan using its exact updated_at version.',
      inputSchema: MCP_PLAN_UPDATE_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('write:plans')) return insufficientScopeResult();
      return handleMutation('plans_update', () =>
        new McpMutationClient().updatePlan({
          operationId: input.operationId,
          planId: input.planId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.activityId !== undefined ? { activityId: input.activityId } : {}),
          ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
          ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerPlansDeleteTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.delete',
    {
      title: 'Move a Dayopt plan to trash',
      description: 'Soft-delete one active Plan using its exact updated_at version.',
      inputSchema: MCP_PLAN_VERSIONED_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_DELETED_RECEIPT_SCHEMA,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('delete:plans')) return insufficientScopeResult();
      return handleMutation('plans_delete', () =>
        new McpMutationClient().deletePlan({
          ...input,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerPlansRestoreTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.restore',
    {
      title: 'Restore a Dayopt plan',
      description: 'Restore one trashed Plan using its exact updated_at version.',
      inputSchema: MCP_PLAN_VERSIONED_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('delete:plans')) return insufficientScopeResult();
      return handleMutation('plans_restore', () =>
        new McpMutationClient().restorePlan({
          ...input,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerRecordsCreateTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.create',
    {
      title: 'Create a Dayopt record',
      description: 'Create one past Record as canonical Dayopt data.',
      inputSchema: MCP_RECORD_CREATE_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('write:records')) return insufficientScopeResult();
      return handleMutation('records_create', () =>
        new McpMutationClient().createRecord({
          ...input,
          note: input.note ?? null,
          activityId: input.activityId ?? null,
          planId: input.planId ?? null,
          fulfillment: input.fulfillment ?? null,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerRecordsUpdateTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.update',
    {
      title: 'Update a Dayopt record',
      description: 'Update one active Record using its exact updated_at version.',
      inputSchema: MCP_RECORD_UPDATE_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('write:records')) return insufficientScopeResult();
      return handleMutation('records_update', () =>
        new McpMutationClient().updateRecord({
          operationId: input.operationId,
          recordId: input.recordId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.activityId !== undefined ? { activityId: input.activityId } : {}),
          ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
          ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
          ...(input.fulfillment !== undefined ? { fulfillment: input.fulfillment } : {}),
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerRecordsDeleteTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.delete',
    {
      title: 'Move a Dayopt record to trash',
      description: 'Soft-delete one active Record using its exact updated_at version.',
      inputSchema: MCP_RECORD_VERSIONED_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_DELETED_RECEIPT_SCHEMA,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('delete:records')) return insufficientScopeResult();
      return handleMutation('records_delete', () =>
        new McpMutationClient().deleteRecord({
          ...input,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

export function registerRecordsRestoreTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.restore',
    {
      title: 'Restore a Dayopt record',
      description: 'Restore one trashed Record using its exact updated_at version.',
      inputSchema: MCP_RECORD_VERSIONED_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_ACTIVE_RECEIPT_SCHEMA,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      if (!ctx.scopes.includes('delete:records')) return insufficientScopeResult();
      return handleMutation('records_restore', () =>
        new McpMutationClient().restoreRecord({
          ...input,
          connectionId: ctx.connectionId,
          accessTokenId: ctx.tokenId,
        }),
      );
    },
  );
}

async function handleMutation(
  operation: string,
  mutate: () => Promise<PublicMutationReceipt>,
): Promise<CallToolResult> {
  try {
    return createMcpToolSuccess({ ...(await mutate()) });
  } catch (error) {
    if (error instanceof McpMutationError) {
      return createMcpToolError(error.code, error.message, isRetryableMutationError(error.code));
    }

    captureUnexpectedMcpToolError(error, operation);
    logger.error(`MCP ${operation} failed`);
    return createMcpToolError('MUTATION_FAILED', 'Dayopt could not apply the change.', true);
  }
}

interface PublicMutationReceipt {
  // MCP_MUTATION_RECEIPT_SCHEMA_VERSION 参照。mutationReceiptOutputSchema と同じ理由で
  // MCP_TOOL_SCHEMA_VERSION とは独立に保つ。
  schemaVersion: typeof MCP_MUTATION_RECEIPT_SCHEMA_VERSION;
  operationId: string;
  resourceType: 'plan' | 'record';
  resourceId: string;
  version: string;
  deletedAt: string | null;
  replayed: boolean;
}

function insufficientScopeResult(): CallToolResult {
  return createMcpToolError(
    'INSUFFICIENT_SCOPE',
    'This connection does not have the scope required for this change.',
  );
}

function isRetryableMutationError(code: McpMutationErrorCode): boolean {
  return code === 'CONFLICT' || code === 'WRITE_DISABLED' || code === 'MUTATION_FAILED';
}
