import 'server-only';

import { trackProductEvent, trackProductEvents } from '@/lib/analytics/product-events';

import type {
  ConfirmDayInput,
  CreatePlanInput,
  CreateRecordInput,
  UpdatePlanInput,
  UpdateRecordInput,
} from '../schemas/timeblock';
import { parseFulfillment } from '../schemas/timeblock';
import { assertActivityAssignable } from './activity-assignment-guard';
import { PlanService } from './plan-service';
import { RecordService } from './record-service';
import {
  createTimeblockCommandClient,
  type TimeblockCommandClient,
  toTimeblockSource,
} from './timeblock-command-client';
import type { PlanRow, RecordRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

interface UserCommandOptions<TInput> {
  userId: string;
  input: TInput;
}

interface VersionedTargetOptions {
  userId: string;
  id: string;
  expectedUpdatedAt: string;
}

interface VersionedUpdateOptions<TInput> extends VersionedTargetOptions {
  input: TInput;
}

/**
 * UI向けのversioned command service。
 *
 * legacy routeを支えるPlanService / RecordServiceも同じcommand boundaryへ移ったため、
 * このserviceは「raw CAS tokenを呼び出し元から受け取るUI経路」という差分だけを持つ。
 */
export class TimeblockCommandService {
  private readonly plans: PlanService;
  private readonly records: RecordService;

  constructor(
    private readonly supabase: ServiceSupabaseClient,
    private readonly commands: TimeblockCommandClient = createTimeblockCommandClient(),
  ) {
    // read 専用 service。write は下の this.commands（TimeblockCommandClient）だけが持つ
    this.plans = new PlanService(supabase);
    this.records = new RecordService(supabase);
  }

  async createPlan(options: UserCommandOptions<CreatePlanInput>): Promise<PlanRow> {
    const { userId, input } = options;
    const plan = await this.commands.createPlan({
      userId,
      title: input.title,
      note: input.note ?? null,
      activityId: input.activityId ?? null,
      externalCalendarEventId: input.externalCalendarEventId ?? null,
      source: input.externalCalendarEventId ? 'external_calendar' : 'manual',
      startAt: input.start_at,
      endAt: input.end_at,
    });
    await trackProductEvent({ eventName: 'plan_created', userId });
    return plan;
  }

  async updatePlan(options: VersionedUpdateOptions<UpdatePlanInput>): Promise<PlanRow> {
    const { userId, id, input, expectedUpdatedAt } = options;
    const existing = await this.plans.getById({ userId, planId: id });
    if (input.activityId !== undefined && input.activityId !== existing.activity_id) {
      await assertActivityAssignable(this.supabase, userId, input.activityId);
    }
    return this.commands.updatePlan({
      userId,
      planId: id,
      expectedUpdatedAt,
      title: input.title ?? existing.title,
      note: input.note === undefined ? existing.note : input.note,
      activityId: input.activityId === undefined ? existing.activity_id : input.activityId,
      externalCalendarEventId:
        input.externalCalendarEventId === undefined
          ? existing.external_calendar_event_id
          : input.externalCalendarEventId,
      source: toTimeblockSource(existing.source),
      startAt: input.start_at ?? existing.start_at,
      endAt: input.end_at ?? existing.end_at,
    });
  }

  deletePlan(options: VersionedTargetOptions): Promise<PlanRow> {
    return this.commands.deletePlan({
      userId: options.userId,
      planId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
  }

  restorePlan(options: VersionedTargetOptions): Promise<PlanRow> {
    return this.commands.restorePlan({
      userId: options.userId,
      planId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
  }

  setPlanSkipped(options: VersionedTargetOptions & { skipped: boolean }): Promise<PlanRow> {
    return this.commands.setPlanSkipped({
      userId: options.userId,
      planId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
      skipped: options.skipped,
    });
  }

  async recordPlan(options: VersionedTargetOptions): Promise<RecordRow> {
    const record = await this.commands.recordPlan({
      userId: options.userId,
      planId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
    await trackProductEvent({ eventName: 'record_created', userId: options.userId });
    return record;
  }

  async confirmDay(options: UserCommandOptions<ConfirmDayInput>): Promise<RecordRow[]> {
    const records = await this.commands.confirmDay({
      userId: options.userId,
      startAt: options.input.start_at,
      endAt: options.input.end_at,
    });
    await trackProductEvents(
      records.map(() => ({ eventName: 'record_created' as const, userId: options.userId })),
    );
    return records;
  }

  async createRecord(options: UserCommandOptions<CreateRecordInput>): Promise<RecordRow> {
    const { userId, input } = options;
    const record = await this.commands.createRecord({
      userId,
      title: input.title,
      note: input.note ?? null,
      activityId: input.activityId ?? null,
      planId: input.planId ?? null,
      externalCalendarEventId: input.externalCalendarEventId ?? null,
      source: input.externalCalendarEventId ? 'external_calendar' : 'manual',
      startAt: input.start_at,
      endAt: input.end_at,
      fulfillment: input.fulfillment ?? null,
    });
    await trackProductEvent({ eventName: 'record_created', userId });
    return record;
  }

  async updateRecord(options: VersionedUpdateOptions<UpdateRecordInput>): Promise<RecordRow> {
    const { userId, id, input, expectedUpdatedAt } = options;
    const existing = await this.records.getById({ userId, recordId: id });
    if (input.activityId !== undefined && input.activityId !== existing.activity_id) {
      await assertActivityAssignable(this.supabase, userId, input.activityId);
    }
    return this.commands.updateRecord({
      userId,
      recordId: id,
      expectedUpdatedAt,
      title: input.title ?? existing.title,
      note: input.note === undefined ? existing.note : input.note,
      activityId: input.activityId === undefined ? existing.activity_id : input.activityId,
      planId: input.planId === undefined ? existing.plan_id : input.planId,
      externalCalendarEventId:
        input.externalCalendarEventId === undefined
          ? existing.external_calendar_event_id
          : input.externalCalendarEventId,
      source: toTimeblockSource(existing.source),
      startAt: input.start_at ?? existing.start_at,
      endAt: input.end_at ?? existing.end_at,
      fulfillment:
        input.fulfillment === undefined
          ? parseFulfillment(existing.fulfillment)
          : input.fulfillment,
    });
  }

  deleteRecord(options: VersionedTargetOptions): Promise<RecordRow> {
    return this.commands.deleteRecord({
      userId: options.userId,
      recordId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
  }

  restoreRecord(options: VersionedTargetOptions): Promise<RecordRow> {
    return this.commands.restoreRecord({
      userId: options.userId,
      recordId: options.id,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
  }
}

export function createTimeblockCommandService(
  supabase: ServiceSupabaseClient,
): TimeblockCommandService {
  return new TimeblockCommandService(supabase);
}
