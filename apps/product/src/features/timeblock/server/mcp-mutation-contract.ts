export const MCP_MUTATION_RECEIPT_SCHEMA_VERSION = 1 as const;

interface McpMutationBinding {
  connectionId: string;
  accessTokenId: string;
  operationId: string;
}

export interface McpPlanCreateInput extends McpMutationBinding {
  title: string;
  note: string | null;
  activityId: string | null;
  startAt: string;
  endAt: string;
}

interface McpPlanVersionedInput extends McpMutationBinding {
  planId: string;
  /** Raw PostgreSQL timestamptz version. Do not round-trip through Date. */
  expectedUpdatedAt: string;
}

export interface McpPlanUpdateInput extends McpPlanVersionedInput {
  /** Omitted fields are preserved. An explicit null clears note or activity. */
  title?: string;
  note?: string | null;
  activityId?: string | null;
  startAt?: string;
  endAt?: string;
}

export type McpPlanDeleteInput = McpPlanVersionedInput;
export type McpPlanRestoreInput = McpPlanVersionedInput;

export type McpFulfillment = 'low' | 'medium' | 'high';

export interface McpRecordCreateInput extends McpMutationBinding {
  title: string;
  note: string | null;
  activityId: string | null;
  /** Null creates an unplanned Record; a UUID links it to a completed Plan. */
  planId: string | null;
  startAt: string;
  endAt: string;
  fulfillment: McpFulfillment | null;
}

interface McpRecordVersionedInput extends McpMutationBinding {
  recordId: string;
  /** Raw PostgreSQL timestamptz version. Do not round-trip through Date. */
  expectedUpdatedAt: string;
}

export interface McpRecordUpdateInput extends McpRecordVersionedInput {
  /** Omitted fields are preserved. An explicit null clears note, activity, or fulfillment. */
  title?: string;
  note?: string | null;
  activityId?: string | null;
  startAt?: string;
  endAt?: string;
  fulfillment?: McpFulfillment | null;
}

export type McpRecordDeleteInput = McpRecordVersionedInput;
export type McpRecordRestoreInput = McpRecordVersionedInput;

interface McpPlanMutationReceipt<TDeletedAt extends string | null> {
  schemaVersion: typeof MCP_MUTATION_RECEIPT_SCHEMA_VERSION;
  operationId: string;
  resourceType: 'plan';
  resourceId: string;
  /** Raw PostgreSQL timestamptz version. Do not round-trip through Date. */
  version: string;
  deletedAt: TDeletedAt;
  replayed: boolean;
}

export type McpPlanCreateReceipt = McpPlanMutationReceipt<null>;
export type McpPlanUpdateReceipt = McpPlanMutationReceipt<null>;
export type McpPlanDeleteReceipt = McpPlanMutationReceipt<string>;
export type McpPlanRestoreReceipt = McpPlanMutationReceipt<null>;

interface McpRecordMutationReceipt<TDeletedAt extends string | null> {
  schemaVersion: typeof MCP_MUTATION_RECEIPT_SCHEMA_VERSION;
  operationId: string;
  resourceType: 'record';
  resourceId: string;
  /** Raw PostgreSQL timestamptz version. Do not round-trip through Date. */
  version: string;
  deletedAt: TDeletedAt;
  replayed: boolean;
}

export type McpRecordCreateReceipt = McpRecordMutationReceipt<null>;
export type McpRecordUpdateReceipt = McpRecordMutationReceipt<null>;
export type McpRecordDeleteReceipt = McpRecordMutationReceipt<string>;
export type McpRecordRestoreReceipt = McpRecordMutationReceipt<null>;

export type McpMutationErrorCode =
  | 'ACTIVITY_ARCHIVED'
  | 'AUTHORIZATION_LOST'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_INPUT'
  | 'INVALID_TIME_RANGE'
  | 'MUTATION_FAILED'
  | 'NOT_FOUND'
  | 'PRO_REQUIRED'
  | 'RECORD_IN_FUTURE'
  | 'TIME_OVERLAP'
  | 'WRITE_DISABLED';

export class McpMutationError extends Error {
  constructor(
    public readonly code: McpMutationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'McpMutationError';
  }
}
