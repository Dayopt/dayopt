import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  createTimeblockTrashReadClient,
  TimeblockTrashReadError,
  transformPlanReadModel,
  transformRecordReadModel,
} from '@/features/timeblock/server/service-index';
import { logger } from '@/lib/logger';
import { captureUnexpectedMcpToolError } from '@/lib/mcp/tool-error';
import { createMcpTrpcCaller } from '@/lib/mcp/trpc-bridge';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRequestContext } from '../_context';
import {
  MCP_PLAN_GET_OUTPUT_SCHEMA,
  MCP_PLAN_LIST_OUTPUT_SCHEMA,
  MCP_RECORD_GET_OUTPUT_SCHEMA,
  MCP_RECORD_LIST_OUTPUT_SCHEMA,
} from './timeblock-contract';
import { createMcpToolError, createMcpToolSuccess, MCP_TOOL_SCHEMA_VERSION } from './tool-result';
import { MCP_UNTRUSTED_CONTENT_NOTICE } from './untrusted-data-serialization';

export const MCP_PLAN_GET_INPUT_SCHEMA = z.object({ planId: z.string().uuid() }).strict();
export const MCP_RECORD_GET_INPUT_SCHEMA = z.object({ recordId: z.string().uuid() }).strict();
export const MCP_TRASH_LIST_INPUT_SCHEMA = z
  .object({ limit: z.number().int().min(1).max(100).optional() })
  .strict();

export function registerPlansGetTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.get',
    {
      title: 'Get a Dayopt plan',
      description: `Get one active Plan owned by the authenticated Dayopt user. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_PLAN_GET_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_GET_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ planId }) => {
      if (!ctx.scopes.includes('read:entries')) return insufficientScopeResult();
      try {
        const trpc = createReadCaller(ctx);
        const plan = transformPlanReadModel(await trpc.plans.getById({ id: planId }));
        return createMcpToolSuccess({ schemaVersion: MCP_TOOL_SCHEMA_VERSION, plan });
      } catch (error) {
        return getErrorResult(error, 'plans_get', 'Plan');
      }
    },
  );
}

export function registerRecordsGetTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.get',
    {
      title: 'Get a Dayopt record',
      description: `Get one active Record owned by the authenticated Dayopt user. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_RECORD_GET_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_GET_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ recordId }) => {
      if (!ctx.scopes.includes('read:entries')) return insufficientScopeResult();
      try {
        const trpc = createReadCaller(ctx);
        const record = transformRecordReadModel(await trpc.records.getById({ id: recordId }));
        return createMcpToolSuccess({ schemaVersion: MCP_TOOL_SCHEMA_VERSION, record });
      } catch (error) {
        return getErrorResult(error, 'records_get', 'Record');
      }
    },
  );
}

export function registerPlansTrashListTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'plans.trash.list',
    {
      title: 'List trashed Dayopt plans',
      description: `List soft-deleted Plans owned by the authenticated Dayopt user. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_TRASH_LIST_INPUT_SCHEMA,
      outputSchema: MCP_PLAN_LIST_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      if (!ctx.scopes.includes('delete:plans')) return insufficientScopeResult();
      try {
        const plans = (
          await createTimeblockTrashReadClient().listDeletedPlans(ctx.userId, limit ?? 50)
        ).map(transformPlanReadModel);
        return createMcpToolSuccess({
          schemaVersion: MCP_TOOL_SCHEMA_VERSION,
          count: plans.length,
          plans,
        });
      } catch (error) {
        return trashErrorResult(error, 'plans_trash_list', 'plans');
      }
    },
  );
}

export function registerRecordsTrashListTool(server: McpServer, ctx: McpRequestContext) {
  server.registerTool(
    'records.trash.list',
    {
      title: 'List trashed Dayopt records',
      description: `List soft-deleted Records owned by the authenticated Dayopt user. ${MCP_UNTRUSTED_CONTENT_NOTICE}`,
      inputSchema: MCP_TRASH_LIST_INPUT_SCHEMA,
      outputSchema: MCP_RECORD_LIST_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      if (!ctx.scopes.includes('delete:records')) return insufficientScopeResult();
      try {
        const records = (
          await createTimeblockTrashReadClient().listDeletedRecords(ctx.userId, limit ?? 50)
        ).map(transformRecordReadModel);
        return createMcpToolSuccess({
          schemaVersion: MCP_TOOL_SCHEMA_VERSION,
          count: records.length,
          records,
        });
      } catch (error) {
        return trashErrorResult(error, 'records_trash_list', 'records');
      }
    },
  );
}

function createReadCaller(ctx: McpRequestContext) {
  return createMcpTrpcCaller({
    userId: ctx.userId,
    clientId: ctx.clientId,
    scopes: ctx.scopes,
  });
}

function insufficientScopeResult() {
  return createMcpToolError(
    'INSUFFICIENT_SCOPE',
    'This connection does not have the scope required for this tool.',
  );
}

function getErrorResult(error: unknown, operation: string, resourceName: string) {
  if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
    return createMcpToolError('NOT_FOUND', `${resourceName} was not found.`);
  }
  captureUnexpectedMcpToolError(error, operation);
  logger.error(`MCP ${operation} failed`);
  return createMcpToolError('READ_FAILED', `${resourceName} could not be loaded.`, true);
}

function trashErrorResult(error: unknown, operation: string, resourceName: string) {
  if (!(error instanceof TimeblockTrashReadError)) {
    captureUnexpectedMcpToolError(error, operation);
  }
  logger.error(`MCP ${operation} failed`);
  return createMcpToolError('READ_FAILED', `Trashed ${resourceName} could not be loaded.`, true);
}
