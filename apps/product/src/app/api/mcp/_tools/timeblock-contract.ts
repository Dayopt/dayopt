import { z } from 'zod';

import { MCP_TOOL_SCHEMA_VERSION } from './tool-result';

const MCP_PLAN_OUTPUT_SCHEMA = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    note: z.string().nullable(),
    activityId: z.string().uuid().nullable(),
    startAt: z.string(),
    endAt: z.string(),
    source: z.string(),
    deletedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const MCP_RECORD_OUTPUT_SCHEMA = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    note: z.string().nullable(),
    activityId: z.string().uuid().nullable(),
    startAt: z.string(),
    endAt: z.string(),
    source: z.string(),
    fulfillment: z.enum(['low', 'medium', 'high']).nullable(),
    deletedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const MCP_ENTRY_OUTPUT_SCHEMA = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    origin: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    actualStartTime: z.string().nullable(),
    actualEndTime: z.string().nullable(),
    durationMinutes: z.number().nullable(),
    activityId: z.string().uuid().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export const MCP_PLAN_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    plans: z.array(MCP_PLAN_OUTPUT_SCHEMA),
  })
  .strict();

export const MCP_RECORD_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    records: z.array(MCP_RECORD_OUTPUT_SCHEMA),
  })
  .strict();

export const MCP_PLAN_GET_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    plan: MCP_PLAN_OUTPUT_SCHEMA,
  })
  .strict();

export const MCP_RECORD_GET_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    record: MCP_RECORD_OUTPUT_SCHEMA,
  })
  .strict();

export const MCP_ENTRY_LIST_OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_SCHEMA_VERSION),
    count: z.number().int().nonnegative(),
    entries: z.array(MCP_ENTRY_OUTPUT_SCHEMA),
  })
  .strict();
