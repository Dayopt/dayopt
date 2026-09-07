import 'server-only';

import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import {
  MCP_MUTATION_RECEIPT_SCHEMA_VERSION,
  McpMutationError,
  type McpMutationErrorCode,
  type McpPlanCreateInput,
  type McpPlanCreateReceipt,
  type McpPlanDeleteInput,
  type McpPlanDeleteReceipt,
  type McpPlanRestoreInput,
  type McpPlanRestoreReceipt,
  type McpPlanUpdateInput,
  type McpPlanUpdateReceipt,
  type McpRecordCreateInput,
  type McpRecordCreateReceipt,
  type McpRecordDeleteInput,
  type McpRecordDeleteReceipt,
  type McpRecordRestoreInput,
  type McpRecordRestoreReceipt,
  type McpRecordUpdateInput,
  type McpRecordUpdateReceipt,
} from './mcp-mutation-contract';
import { createMcpMutationDb } from './mcp-mutation-db';

interface MutationDatabaseError {
  code?: unknown;
}

const EXPECTED_ERROR_CODES: Readonly<Record<string, McpMutationErrorCode>> = {
  '22004': 'INVALID_INPUT',
  '22023': 'INVALID_INPUT',
  '23P01': 'TIME_OVERLAP',
  '55P03': 'CONFLICT',
  '57014': 'CONFLICT',
  DM003: 'WRITE_DISABLED',
  DM004: 'AUTHORIZATION_LOST',
  DM005: 'PRO_REQUIRED',
  DM006: 'IDEMPOTENCY_KEY_REUSED',
  DT001: 'NOT_FOUND',
  DT002: 'CONFLICT',
  DT003: 'INVALID_TIME_RANGE',
  DT005: 'RECORD_IN_FUTURE',
  DT008: 'INVALID_INPUT',
  DT009: 'FORBIDDEN',
  DT012: 'INVALID_INPUT',
  DT014: 'ACTIVITY_ARCHIVED',
};

const ERROR_MESSAGES: Readonly<Record<McpMutationErrorCode, string>> = {
  ACTIVITY_ARCHIVED: 'This activity is archived and cannot be assigned to a plan or record.',
  AUTHORIZATION_LOST: 'The Dayopt connection is no longer authorized for this change.',
  CONFLICT:
    'The change is busy or conflicted with another update. Read the latest data and try again.',
  FORBIDDEN: 'This item cannot be changed.',
  IDEMPOTENCY_KEY_REUSED: 'This operation ID was already used for a different change.',
  INVALID_INPUT: 'The mutation input is invalid.',
  INVALID_TIME_RANGE: 'Time range end must be after start.',
  MUTATION_FAILED: 'Dayopt could not apply the change.',
  NOT_FOUND: 'The requested item was not found.',
  PRO_REQUIRED: 'Dayopt Pro is required for MCP changes.',
  RECORD_IN_FUTURE: 'Records cannot end in the future.',
  TIME_OVERLAP: 'This time range overlaps with an existing item.',
  WRITE_DISABLED: 'Dayopt MCP changes are temporarily disabled.',
};

class SanitizedMcpMutationDatabaseError extends Error {
  constructor(public readonly code: string) {
    super('Unexpected MCP mutation database failure');
    this.name = 'SanitizedMcpMutationDatabaseError';
  }
}

function mutationError(code: McpMutationErrorCode): McpMutationError {
  return new McpMutationError(code, ERROR_MESSAGES[code]);
}

function throwMutationDatabaseError(error: MutationDatabaseError, operation: string): never {
  const databaseCode =
    typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : undefined;
  const mappedCode = databaseCode ? EXPECTED_ERROR_CODES[databaseCode] : undefined;
  if (mappedCode) throw mutationError(mappedCode);
  if (databaseCode === '40P01') throw mutationError('CONFLICT');

  // Do not attach the PostgREST object as a cause: database messages can contain
  // private constraint details. The stable SQLSTATE is sufficient for triage.
  const original = captureUnexpectedDatabaseError(
    new SanitizedMcpMutationDatabaseError(databaseCode ?? 'UNKNOWN'),
    {
      feature: 'mcp',
      operation,
    },
  );
  throw new McpMutationError('MUTATION_FAILED', ERROR_MESSAGES.MUTATION_FAILED, {
    cause: original,
  });
}

type MutationResourceType = 'plan' | 'record';

interface MutationReceiptRow<
  TResourceType extends MutationResourceType,
  TDeletedAt extends string | null,
> {
  schema_version: typeof MCP_MUTATION_RECEIPT_SCHEMA_VERSION;
  operation_id: string;
  resource_type: TResourceType;
  resource_id: string;
  version: string;
  deleted_at: TDeletedAt;
  replayed: boolean;
}

function hasMutationReceiptShape<TResourceType extends MutationResourceType>(
  row: unknown,
  expectedOperationId: string,
  expectedResourceType: TResourceType,
  expectedResourceId?: string,
): row is MutationReceiptRow<TResourceType, string | null> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  return (
    candidate.schema_version === MCP_MUTATION_RECEIPT_SCHEMA_VERSION &&
    candidate.operation_id === expectedOperationId &&
    candidate.resource_type === expectedResourceType &&
    typeof candidate.resource_id === 'string' &&
    (expectedResourceId === undefined || candidate.resource_id === expectedResourceId) &&
    typeof candidate.version === 'string' &&
    typeof candidate.replayed === 'boolean'
  );
}

function isActiveMutationReceipt<TResourceType extends MutationResourceType>(
  row: unknown,
  expectedOperationId: string,
  expectedResourceType: TResourceType,
  expectedResourceId?: string,
): row is MutationReceiptRow<TResourceType, null> {
  return (
    hasMutationReceiptShape(row, expectedOperationId, expectedResourceType, expectedResourceId) &&
    row.deleted_at === null
  );
}

function isDeletedMutationReceipt<TResourceType extends MutationResourceType>(
  row: unknown,
  expectedOperationId: string,
  expectedResourceType: TResourceType,
  expectedResourceId: string,
): row is MutationReceiptRow<TResourceType, string> {
  return (
    hasMutationReceiptShape(row, expectedOperationId, expectedResourceType, expectedResourceId) &&
    typeof row.deleted_at === 'string'
  );
}

function toMutationReceipt<
  TResourceType extends MutationResourceType,
  TDeletedAt extends string | null,
>(row: MutationReceiptRow<TResourceType, TDeletedAt>) {
  return {
    schemaVersion: row.schema_version,
    operationId: row.operation_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    version: row.version,
    deletedAt: row.deleted_at,
    replayed: row.replayed,
  };
}

interface MutationRpcResult {
  data: unknown[] | null;
  error: MutationDatabaseError | null;
}

async function requestMutationRows(
  request: () => PromiseLike<MutationRpcResult>,
  operation: string,
): Promise<unknown[]> {
  let result: MutationRpcResult;
  try {
    result = await request();
    if (result.error?.code === '40P01') result = await request();
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throwMutationDatabaseError({ code }, operation);
  }

  if (result.error) throwMutationDatabaseError(result.error, operation);
  return result.data ?? [];
}

function requireActiveMutationReceipt<TResourceType extends MutationResourceType>(
  rows: unknown[],
  operationId: string,
  operation: string,
  expectedResourceType: TResourceType,
  expectedResourceId?: string,
): MutationReceiptRow<TResourceType, null> {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!isActiveMutationReceipt(row, operationId, expectedResourceType, expectedResourceId)) {
    throwMutationDatabaseError({ code: 'INVALID_RECEIPT' }, operation);
  }
  return row;
}

function requireDeletedMutationReceipt<TResourceType extends MutationResourceType>(
  rows: unknown[],
  operationId: string,
  operation: string,
  expectedResourceType: TResourceType,
  expectedResourceId: string,
): MutationReceiptRow<TResourceType, string> {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!isDeletedMutationReceipt(row, operationId, expectedResourceType, expectedResourceId)) {
    throwMutationDatabaseError({ code: 'INVALID_RECEIPT' }, operation);
  }
  return row;
}

/**
 * Service-role access stays inside this adapter. Callers provide only the
 * current OAuth binding and typed Plan / Record fields; arbitrary SQL/table
 * access is not exposed.
 *
 * 内部の service-role handle は apply RPC 8 本だけを型で絞った `db` 1 つ。
 * アーカイブ済みアクティビティの拒否は DB の command 境界が担う
 * (`assert_active_timeblock_activity_v1` が DT014 を投げる) ため、この adapter は
 * activities を直接読まない (#1824)。
 */
export class McpMutationClient {
  /**
   * `db` は apply RPC 専用の narrow client。default 引数はテストで fake に
   * 差し替えられるよう constructor に置く。
   */
  constructor(
    private readonly db: ReturnType<typeof createMcpMutationDb> = createMcpMutationDb(),
  ) {}

  async createPlan(input: McpPlanCreateInput): Promise<McpPlanCreateReceipt> {
    const operation = 'apply_mcp_plan_create';
    const request = () =>
      this.db.applyPlanCreate({
        p_access_token_id: input.accessTokenId,
        p_activity_id: input.activityId,
        p_connection_id: input.connectionId,
        p_end_at: input.endAt,
        p_note: input.note,
        p_operation_id: input.operationId,
        p_start_at: input.startAt,
        p_title: input.title,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'plan'),
    );
  }

  async updatePlan(input: McpPlanUpdateInput): Promise<McpPlanUpdateReceipt> {
    const operation = 'apply_mcp_plan_update';
    const request = () =>
      this.db.applyPlanUpdate({
        p_access_token_id: input.accessTokenId,
        p_activity_id: input.activityId ?? null,
        p_activity_id_present: input.activityId !== undefined,
        p_connection_id: input.connectionId,
        p_end_at: input.endAt ?? null,
        p_end_at_present: input.endAt !== undefined,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_note: input.note ?? null,
        p_note_present: input.note !== undefined,
        p_operation_id: input.operationId,
        p_plan_id: input.planId,
        p_start_at: input.startAt ?? null,
        p_start_at_present: input.startAt !== undefined,
        p_title: input.title ?? null,
        p_title_present: input.title !== undefined,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'plan', input.planId),
    );
  }

  async deletePlan(input: McpPlanDeleteInput): Promise<McpPlanDeleteReceipt> {
    const operation = 'apply_mcp_plan_delete';
    const request = () =>
      this.db.applyPlanDelete({
        p_access_token_id: input.accessTokenId,
        p_connection_id: input.connectionId,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_operation_id: input.operationId,
        p_plan_id: input.planId,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireDeletedMutationReceipt(rows, input.operationId, operation, 'plan', input.planId),
    );
  }

  async restorePlan(input: McpPlanRestoreInput): Promise<McpPlanRestoreReceipt> {
    const operation = 'apply_mcp_plan_restore';
    const request = () =>
      this.db.applyPlanRestore({
        p_access_token_id: input.accessTokenId,
        p_connection_id: input.connectionId,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_operation_id: input.operationId,
        p_plan_id: input.planId,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'plan', input.planId),
    );
  }

  async createRecord(input: McpRecordCreateInput): Promise<McpRecordCreateReceipt> {
    const operation = 'apply_mcp_record_create';
    const request = () =>
      this.db.applyRecordCreate({
        p_access_token_id: input.accessTokenId,
        p_activity_id: input.activityId,
        p_connection_id: input.connectionId,
        p_end_at: input.endAt,
        p_fulfillment: input.fulfillment,
        p_note: input.note,
        p_operation_id: input.operationId,
        p_plan_id: input.planId,
        p_start_at: input.startAt,
        p_title: input.title,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'record'),
    );
  }

  async updateRecord(input: McpRecordUpdateInput): Promise<McpRecordUpdateReceipt> {
    const operation = 'apply_mcp_record_update';
    const request = () =>
      this.db.applyRecordUpdate({
        p_access_token_id: input.accessTokenId,
        p_activity_id: input.activityId ?? null,
        p_activity_id_present: input.activityId !== undefined,
        p_connection_id: input.connectionId,
        p_end_at: input.endAt ?? null,
        p_end_at_present: input.endAt !== undefined,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_fulfillment: input.fulfillment ?? null,
        p_fulfillment_present: input.fulfillment !== undefined,
        p_note: input.note ?? null,
        p_note_present: input.note !== undefined,
        p_operation_id: input.operationId,
        p_record_id: input.recordId,
        p_start_at: input.startAt ?? null,
        p_start_at_present: input.startAt !== undefined,
        p_title: input.title ?? null,
        p_title_present: input.title !== undefined,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'record', input.recordId),
    );
  }

  async deleteRecord(input: McpRecordDeleteInput): Promise<McpRecordDeleteReceipt> {
    const operation = 'apply_mcp_record_delete';
    const request = () =>
      this.db.applyRecordDelete({
        p_access_token_id: input.accessTokenId,
        p_connection_id: input.connectionId,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_operation_id: input.operationId,
        p_record_id: input.recordId,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireDeletedMutationReceipt(rows, input.operationId, operation, 'record', input.recordId),
    );
  }

  async restoreRecord(input: McpRecordRestoreInput): Promise<McpRecordRestoreReceipt> {
    const operation = 'apply_mcp_record_restore';
    const request = () =>
      this.db.applyRecordRestore({
        p_access_token_id: input.accessTokenId,
        p_connection_id: input.connectionId,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_operation_id: input.operationId,
        p_record_id: input.recordId,
      });

    const rows = await requestMutationRows(request, operation);
    return toMutationReceipt(
      requireActiveMutationReceipt(rows, input.operationId, operation, 'record', input.recordId),
    );
  }
}
