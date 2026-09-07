import 'server-only';

import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import { TimeblockServiceError } from './timeblock-service-error';
import type { PlanRow, RecordRow } from './timeblock-types';

type TimeblockSource = 'api' | 'external_calendar' | 'manual';

/**
 * 既存行の `source` を command の入力語彙へ丸める。
 *
 * `records.source` は `auto_migrated` / `from_plan` も取りうるが、update command は
 * source を変更しないため既存値の丸めで十分。
 */
export function toTimeblockSource(source: string): TimeblockSource {
  if (source === 'api' || source === 'external_calendar') return source;
  return 'manual';
}

interface CommandError {
  code?: string | undefined;
  message: string;
}

interface CommandResult<TRow> {
  data: TRow[] | null;
  error: CommandError | null;
}

interface CreatePlanCommandInput {
  userId: string;
  title: string;
  note: string | null;
  activityId: string | null;
  externalCalendarEventId: string | null;
  source: TimeblockSource;
  startAt: string;
  endAt: string;
}

interface UpdatePlanCommandInput extends CreatePlanCommandInput {
  planId: string;
  expectedUpdatedAt: string;
}

interface VersionedPlanCommandInput {
  userId: string;
  planId: string;
  expectedUpdatedAt: string;
}

type Fulfillment = 'low' | 'medium' | 'high';

interface CreateRecordCommandInput extends CreatePlanCommandInput {
  planId: string | null;
  fulfillment: Fulfillment | null;
}

interface UpdateRecordCommandInput extends CreateRecordCommandInput {
  recordId: string;
  expectedUpdatedAt: string;
}

interface VersionedRecordCommandInput {
  userId: string;
  recordId: string;
  expectedUpdatedAt: string;
}

interface ConfirmDayCommandInput {
  userId: string;
  startAt: string;
  endAt: string;
}

interface BulkPlanCommandRow {
  title: string;
  activityId: string | null;
  startAt: string;
  endAt: string;
}

interface CreatePlansBulkCommandInput {
  userId: string;
  plans: ReadonlyArray<BulkPlanCommandRow>;
}

type CommandOperation =
  | 'confirm_day_plans'
  | 'create_plan'
  | 'create_plans_bulk'
  | 'create_record'
  | 'delete_plan'
  | 'delete_record'
  | 'record_plan'
  | 'restore_plan'
  | 'restore_record'
  | 'update_plan'
  | 'update_record';

const VERSIONED_TARGET_OPERATIONS = new Set<CommandOperation>([
  'delete_plan',
  'delete_record',
  'record_plan',
  'restore_plan',
  'restore_record',
  'update_plan',
  'update_record',
]);

const EXPECTED_COMMAND_ERRORS: Readonly<Record<string, string>> = {
  '22023': 'INVALID_INPUT',
  '23P01': 'TIME_OVERLAP',
  DT002: 'STALE_VERSION',
  DT003: 'INVALID_TIME_RANGE',
  DT005: 'RECORD_IN_FUTURE',
  DT008: 'INVALID_INPUT',
  DT009: 'FORBIDDEN',
  DT012: 'INVALID_INPUT',
  DT014: 'ACTIVITY_ARCHIVED',
};

const EXPECTED_COMMAND_MESSAGES: Readonly<Record<string, string>> = {
  CONFLICT: 'This command conflicts with another change.',
  FORBIDDEN: 'This item cannot be changed.',
  INVALID_INPUT: 'The timeblock input is invalid.',
  INVALID_TIME_RANGE: 'Time range end must be after start.',
  NOT_FOUND: 'Timeblock not found.',
  RECORD_IN_FUTURE: 'Records cannot end in the future.',
  RETRYABLE_CONTENTION: 'Another write is in progress. Refresh and try again.',
  STALE_TARGET: 'This item no longer exists. Reload the latest data.',
  STALE_VERSION: 'This item was updated elsewhere. Reload the latest data.',
  ACTIVITY_ARCHIVED: 'This activity is archived and cannot be assigned to a plan or record.',
  TEMPORARY_FAILURE: 'The command timed out. Refresh before trying again.',
  TIME_OVERLAP: 'This time range overlaps with an existing item.',
};

function throwExpectedCommandError(code: string): never {
  throw new TimeblockServiceError(
    code,
    EXPECTED_COMMAND_MESSAGES[code] ?? 'The timeblock command was rejected.',
  );
}

function throwCommandError(error: CommandError, operation: CommandOperation): never {
  if (error.code === 'DT001') {
    throwExpectedCommandError(
      VERSIONED_TARGET_OPERATIONS.has(operation) ? 'STALE_TARGET' : 'NOT_FOUND',
    );
  }

  const mappedCode = error.code ? EXPECTED_COMMAND_ERRORS[error.code] : undefined;
  if (mappedCode) throwExpectedCommandError(mappedCode);

  if (error.code === '23505') {
    throwExpectedCommandError('CONFLICT');
  }

  if (error.code === '40P01' || error.code === '55P03') {
    throwExpectedCommandError('RETRYABLE_CONTENTION');
  }

  if (error.code === '57014') {
    throwExpectedCommandError('TEMPORARY_FAILURE');
  }

  const original = captureUnexpectedDatabaseError(error, {
    feature: 'timeblock',
    operation,
  });
  throw new TimeblockServiceError('COMMAND_FAILED', 'Failed to apply timeblock command', {
    cause: original,
  });
}

/**
 * Service-role access is intentionally contained in this typed command adapter.
 * Callers can invoke only tenant-scoped Plan / Record commands and cannot obtain
 * the underlying administrative client.
 */
export class TimeblockCommandClient {
  private readonly admin = createServiceRoleClient();

  async createPlan(input: CreatePlanCommandInput): Promise<PlanRow> {
    return this.run('create_plan', () =>
      this.admin.rpc('create_plan_command_v1', {
        p_activity_id: input.activityId as never,
        p_end_at: input.endAt,
        p_external_calendar_event_id: input.externalCalendarEventId as never,
        p_note: input.note as never,
        p_source: input.source,
        p_start_at: input.startAt,
        p_title: input.title,
        p_user_id: input.userId,
      }),
    );
  }

  async updatePlan(input: UpdatePlanCommandInput): Promise<PlanRow> {
    return this.run('update_plan', () =>
      this.admin.rpc('update_plan_command_v1', {
        p_activity_id: input.activityId as never,
        p_activity_id_present: true,
        p_end_at: input.endAt,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_external_calendar_event_id: input.externalCalendarEventId as never,
        p_note: input.note as never,
        p_plan_id: input.planId,
        p_start_at: input.startAt,
        p_title: input.title,
        p_user_id: input.userId,
      }),
    );
  }

  async deletePlan(input: VersionedPlanCommandInput): Promise<PlanRow> {
    return this.run('delete_plan', () =>
      this.admin.rpc('delete_plan_command_v1', {
        p_expected_updated_at: input.expectedUpdatedAt,
        p_plan_id: input.planId,
        p_user_id: input.userId,
      }),
    );
  }

  async restorePlan(input: VersionedPlanCommandInput): Promise<PlanRow> {
    return this.run('restore_plan', () =>
      this.admin.rpc('restore_plan_command_v1', {
        p_expected_updated_at: input.expectedUpdatedAt,
        p_plan_id: input.planId,
        p_user_id: input.userId,
      }),
    );
  }

  async recordPlan(input: VersionedPlanCommandInput): Promise<RecordRow> {
    return this.run('record_plan', () =>
      this.admin.rpc('record_plan_command_v1', {
        p_expected_updated_at: input.expectedUpdatedAt,
        p_plan_id: input.planId,
        p_user_id: input.userId,
      }),
    );
  }

  /**
   * N 件の Plan を 1 transaction で作る（#2567 テンプレート適用）。
   * 1 件でも検証・overlap で落ちれば全件 rollback される。error code の対応表は
   * 1 件 command と同じ（23P01 → TIME_OVERLAP、DT014 → ACTIVITY_ARCHIVED）。
   */
  async createPlansBulk(input: CreatePlansBulkCommandInput): Promise<PlanRow[]> {
    return this.runMany('create_plans_bulk', () =>
      this.admin.rpc('create_plans_bulk_command_v1', {
        p_plans: input.plans.map((plan) => ({
          title: plan.title,
          activity_id: plan.activityId,
          start_at: plan.startAt,
          end_at: plan.endAt,
        })),
        p_user_id: input.userId,
      }),
    );
  }

  async confirmDay(input: ConfirmDayCommandInput): Promise<RecordRow[]> {
    return this.runMany('confirm_day_plans', () =>
      this.admin.rpc('confirm_day_plans_command_v1', {
        p_end_at: input.endAt,
        p_start_at: input.startAt,
        p_user_id: input.userId,
      }),
    );
  }

  async createRecord(input: CreateRecordCommandInput): Promise<RecordRow> {
    return this.run('create_record', () =>
      this.admin.rpc('create_record_command_v1', {
        p_activity_id: input.activityId as never,
        p_end_at: input.endAt,
        p_external_calendar_event_id: input.externalCalendarEventId as never,
        p_fulfillment: input.fulfillment as never,
        p_note: input.note as never,
        p_plan_id: input.planId as never,
        p_source: input.source,
        p_start_at: input.startAt,
        p_title: input.title,
        p_user_id: input.userId,
      }),
    );
  }

  async updateRecord(input: UpdateRecordCommandInput): Promise<RecordRow> {
    return this.run('update_record', () =>
      this.admin.rpc('update_record_command_v1', {
        p_activity_id: input.activityId as never,
        p_activity_id_present: true,
        p_end_at: input.endAt,
        p_expected_updated_at: input.expectedUpdatedAt,
        p_external_calendar_event_id: input.externalCalendarEventId as never,
        p_fulfillment: input.fulfillment as never,
        p_fulfillment_present: true,
        p_note: input.note as never,
        p_plan_id: input.planId as never,
        p_record_id: input.recordId,
        p_start_at: input.startAt,
        p_title: input.title,
        p_user_id: input.userId,
      }),
    );
  }

  async deleteRecord(input: VersionedRecordCommandInput): Promise<RecordRow> {
    return this.run('delete_record', () =>
      this.admin.rpc('delete_record_command_v1', {
        p_expected_updated_at: input.expectedUpdatedAt,
        p_record_id: input.recordId,
        p_user_id: input.userId,
      }),
    );
  }

  async restoreRecord(input: VersionedRecordCommandInput): Promise<RecordRow> {
    return this.run('restore_record', () =>
      this.admin.rpc('restore_record_command_v1', {
        p_expected_updated_at: input.expectedUpdatedAt,
        p_record_id: input.recordId,
        p_user_id: input.userId,
      }),
    );
  }

  private async run<TRow extends object>(
    operation: CommandOperation,
    request: () => PromiseLike<CommandResult<TRow>>,
  ): Promise<TRow> {
    const rows = await this.runMany(operation, request);
    const row = rows[0];
    if (row) return row;

    const original = captureUnexpectedDatabaseError(
      { message: 'Timeblock command returned no row' },
      { feature: 'timeblock', operation },
    );
    throw new TimeblockServiceError('COMMAND_FAILED', 'Failed to apply timeblock command', {
      cause: original,
    });
  }

  private async runMany<TRow extends object>(
    operation: CommandOperation,
    request: () => PromiseLike<CommandResult<TRow>>,
  ): Promise<TRow[]> {
    let result = await request();
    // PostgreSQL guarantees that the failed transaction was aborted. Only this
    // known-safe failure is retried, and at most once, inside the server adapter.
    if (result.error?.code === '40P01') result = await request();
    if (result.error) throwCommandError(result.error, operation);
    return (result.data ?? []).map((row) => {
      // The expand stage still has inert legacy columns. Never expose them to new clients.
      const projected = { ...row };
      Reflect.deleteProperty(projected, 'plan_id');
      Reflect.deleteProperty(projected, 'skipped_at');
      return projected;
    });
  }
}

export function createTimeblockCommandClient(): TimeblockCommandClient {
  return new TimeblockCommandClient();
}
