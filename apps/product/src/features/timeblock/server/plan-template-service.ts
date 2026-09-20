import { createServiceRoleClient } from '@/lib/supabase/oauth';
import 'server-only';

/**
 * テンプレート（型）の service（#2567）。
 *
 * - `list` / `create` / `rename` / `delete` は RLS の効く user client で直接 DML する
 *   （segments と同じ層。他人の template_id / activity_id は複合 FK が構造で弾く）
 * - `apply` は業務計算（中央値・DST・clip）を TS で行い、原子的 write だけを
 *   `create_plans_bulk_command_v1`（service-role command）へ渡す。template の所有者検証は
 *   RLS client で読む段階で済む（他人の id は行が返らず NOT_FOUND）
 * - プレビュー用の長さ（`previewDurationMinutes`）と適用時の長さは同じ
 *   `resolveTemplateBlockMinutes` を通す。見えている長さと置かれる長さを一致させるため
 */

import { trackProductEvent } from '@/lib/analytics/product-events';
import { MS_PER_DAY } from '@/lib/date/constants';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import {
  aggregateActivityMedianDurations,
  MEDIAN_DURATION_WINDOW_DAYS,
} from '../domain/plan-template-duration';
import {
  materializeTemplateDay,
  PlanTemplateMaterializeError,
  resolveTemplateBlockMinutes,
} from '../domain/plan-template-materialize';
import type {
  ApplyPlanTemplateInput,
  CreatePlanTemplateInput,
  PlanTemplateIdInput,
  RenamePlanTemplateInput,
} from '../schemas/plan-template';

import { fetchRecords } from './statistics-fetchers';
import {
  createTimeblockCommandClient,
  type TimeblockCommandClient,
} from './timeblock-command-client';
import { TimeblockServiceError } from './timeblock-service-error';
import type { PlanRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

/** `user_settings` 行が無い時の既定長。column default（60）と同じ値。 */
const FALLBACK_DEFAULT_MINUTES = 60;

interface PlanTemplateBlockView {
  id: string;
  activityId: string | null;
  title: string;
  anchorMinute: number;
  /** 今適用したら着る長さ（分）。保存値ではなく、直近の中央値 / 既定長から毎回計算する */
  previewDurationMinutes: number;
}

interface PlanTemplateView {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  blocks: PlanTemplateBlockView[];
}

interface UserOptions<TInput> {
  userId: string;
  input: TInput;
}

interface TemplateRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface BlockRow {
  id: string;
  template_id: string;
  activity_id: string | null;
  title: string;
  anchor_minute: number;
}

interface DurationContext {
  timezone: string;
  defaultMinutes: number;
  medianMinutesByActivity: Map<string, number>;
}

interface DatabaseError {
  code?: string | undefined;
  message: string;
}

/** 複合 FK / UNIQUE / CHECK 違反はクライアント入力の問題として BAD_REQUEST 系へ丸める。 */
function toWriteError(error: DatabaseError, operation: string, fallbackCode: string): never {
  if (error.code === '23503' || error.code === '23514') {
    throw new TimeblockServiceError('INVALID_INPUT', 'The template input is invalid.');
  }
  if (error.code === '23505') {
    throw new TimeblockServiceError('CONFLICT', 'Two blocks share the same anchor.');
  }
  const original = captureUnexpectedDatabaseError(error, { feature: 'timeblock', operation });
  throw new TimeblockServiceError(fallbackCode, 'Failed to write plan template', {
    cause: original,
  });
}

function toBlockViews(
  blocks: ReadonlyArray<BlockRow>,
  context: DurationContext,
): PlanTemplateBlockView[] {
  const minutes = resolveTemplateBlockMinutes(
    blocks.map((block) => ({
      id: block.id,
      activityId: block.activity_id,
      positionMinutes: block.anchor_minute,
    })),
    context.medianMinutesByActivity,
    context.defaultMinutes,
  );
  return [...blocks]
    .sort((a, b) => a.anchor_minute - b.anchor_minute)
    .map((block) => ({
      id: block.id,
      activityId: block.activity_id,
      title: block.title,
      anchorMinute: block.anchor_minute,
      previewDurationMinutes: minutes.get(block.id) ?? context.defaultMinutes,
    }));
}

function toView(
  template: TemplateRow,
  blocks: ReadonlyArray<BlockRow>,
  context: DurationContext,
): PlanTemplateView {
  return {
    id: template.id,
    name: template.name,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    blocks: toBlockViews(blocks, context),
  };
}

export class PlanTemplateService {
  constructor(
    private readonly supabase: ServiceSupabaseClient,
    private readonly commands: TimeblockCommandClient = createTimeblockCommandClient(),
    private readonly writes: () => ServiceSupabaseClient = createServiceRoleClient,
  ) {}

  async list(userId: string): Promise<PlanTemplateView[]> {
    const templates = await this.fetchTemplates(userId);
    if (templates.length === 0) return [];
    const [blocks, context] = await Promise.all([
      this.fetchBlocks(
        userId,
        templates.map((template) => template.id),
      ),
      this.loadDurationContext(userId),
    ]);
    return templates.map((template) =>
      toView(
        template,
        blocks.filter((block) => block.template_id === template.id),
        context,
      ),
    );
  }

  /**
   * 生きた日の組成から型を作る。親 → 子の 2 文で、子が失敗したら親を消す（補償）。
   * 中途状態は「空の型」1 行で、RLS の内側にしか残らず、ユーザーが削除できる。
   */
  async create(options: UserOptions<CreatePlanTemplateInput>): Promise<PlanTemplateView> {
    const { userId, input } = options;
    const { data: template, error } = await this.writes()
      .from('plan_templates')
      .insert({ user_id: userId, name: input.name })
      .select('id, name, created_at, updated_at')
      .single();
    if (error || !template) {
      toWriteError(
        error ?? { message: 'Template insert returned no row' },
        'create_plan_template',
        'CREATE_FAILED',
      );
    }

    const { data: blocks, error: blocksError } = await this.writes()
      .from('plan_template_blocks')
      .insert(
        input.blocks.map((block) => ({
          template_id: template.id,
          user_id: userId,
          activity_id: block.activityId,
          title: block.title,
          anchor_minute: block.anchorMinute,
        })),
      )
      .select('id, template_id, activity_id, title, anchor_minute');
    if (blocksError) {
      await this.supabase
        .from('plan_templates')
        .delete()
        .eq('id', template.id)
        .eq('user_id', userId);
      toWriteError(blocksError, 'create_plan_template_blocks', 'CREATE_FAILED');
    }

    const context = await this.loadDurationContext(userId);
    return toView(template, blocks ?? [], context);
  }

  async rename(
    options: UserOptions<RenamePlanTemplateInput>,
  ): Promise<{ id: string; name: string; updatedAt: string }> {
    const { userId, input } = options;
    const { data, error } = await this.writes()
      .from('plan_templates')
      .update({ name: input.name })
      .eq('id', input.templateId)
      .eq('user_id', userId)
      .select('id, name, updated_at')
      .maybeSingle();
    if (error) toWriteError(error, 'rename_plan_template', 'UPDATE_FAILED');
    if (!data) throw new TimeblockServiceError('NOT_FOUND', 'Plan template not found');
    return { id: data.id, name: data.name, updatedAt: data.updated_at };
  }

  async delete(options: UserOptions<PlanTemplateIdInput>): Promise<{ id: string }> {
    const { userId, input } = options;
    const { data, error } = await this.supabase
      .from('plan_templates')
      .delete()
      .eq('id', input.templateId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();
    if (error) toWriteError(error, 'delete_plan_template', 'DELETE_FAILED');
    if (!data) throw new TimeblockServiceError('NOT_FOUND', 'Plan template not found');
    return { id: data.id };
  }

  /**
   * 型を `input.date`（ユーザー timezone の暦日）へ具現化し、N 件の Plan を 1 transaction で置く。
   * 既存 Plan と 1 件でも重なれば command が全件 rollback し `TIME_OVERLAP` を返す。
   */
  async apply(options: UserOptions<ApplyPlanTemplateInput>): Promise<PlanRow[]> {
    const { userId, input } = options;
    const template = await this.fetchTemplate(userId, input.templateId);
    const [blocks, context] = await Promise.all([
      this.fetchBlocks(userId, [template.id]),
      this.loadDurationContext(userId),
    ]);
    const activityIds = [
      ...new Set(blocks.flatMap((block) => (block.activity_id ? [block.activity_id] : []))),
    ];
    const archivedActivityIds = await this.fetchArchivedActivityIds(userId, activityIds);

    let plans;
    try {
      plans = materializeTemplateDay({
        blocks: blocks.map((block) => ({
          id: block.id,
          activityId: block.activity_id,
          title: block.title,
          anchorMinute: block.anchor_minute,
        })),
        dateKey: input.date,
        timezone: context.timezone,
        medianMinutesByActivity: context.medianMinutesByActivity,
        defaultMinutes: context.defaultMinutes,
        archivedActivityIds,
      });
    } catch (error) {
      if (error instanceof PlanTemplateMaterializeError) {
        // 「この型はこの日に収まらない」は client が原因を出し分けられる必要がある
        // （DST の gap 日など、他の日なら通る型がその日だけ落ちるため）
        throw new TimeblockServiceError('TEMPLATE_DOES_NOT_FIT', error.message, { cause: error });
      }
      throw error;
    }

    const rows = await this.commands.createPlansBulk({
      userId,
      plans: plans.map((plan) => ({
        title: plan.title,
        activityId: plan.activityId,
        startAt: plan.startAt,
        endAt: plan.endAt,
      })),
    });
    await trackProductEvent({ eventName: 'plan_created', userId });
    return rows;
  }

  private async fetchTemplates(userId: string): Promise<TemplateRow[]> {
    const { data, error } = await this.supabase
      .from('plan_templates')
      .select('id, name, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch plan templates', {
        cause: captureUnexpectedDatabaseError(error, {
          feature: 'timeblock',
          operation: 'fetch_plan_templates',
        }),
      });
    }
    return data ?? [];
  }

  private async fetchTemplate(userId: string, templateId: string): Promise<TemplateRow> {
    const { data, error } = await this.supabase
      .from('plan_templates')
      .select('id, name, created_at, updated_at')
      .eq('id', templateId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch plan template', {
        cause: captureUnexpectedDatabaseError(error, {
          feature: 'timeblock',
          operation: 'fetch_plan_template',
        }),
      });
    }
    if (!data) throw new TimeblockServiceError('NOT_FOUND', 'Plan template not found');
    return data;
  }

  private async fetchBlocks(userId: string, templateIds: string[]): Promise<BlockRow[]> {
    const { data, error } = await this.supabase
      .from('plan_template_blocks')
      .select('id, template_id, activity_id, title, anchor_minute')
      .eq('user_id', userId)
      .in('template_id', templateIds)
      .order('anchor_minute', { ascending: true });
    if (error) {
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to fetch plan template blocks', {
        cause: captureUnexpectedDatabaseError(error, {
          feature: 'timeblock',
          operation: 'fetch_plan_template_blocks',
        }),
      });
    }
    return data ?? [];
  }

  /**
   * archived な activity の集合。`assertActivityAssignable` は 1 件用で例外を投げる
   * ガードなので使わない — ここでは弾かず、`activity_id = null` で具現化するための情報。
   */
  private async fetchArchivedActivityIds(
    userId: string,
    activityIds: string[],
  ): Promise<Set<string>> {
    if (activityIds.length === 0) return new Set();
    const { data, error } = await this.supabase
      .from('activities')
      .select('id, archived_at')
      .eq('user_id', userId)
      .in('id', activityIds);
    if (error) {
      throw new TimeblockServiceError('FETCH_FAILED', 'Failed to inspect activities', {
        cause: captureUnexpectedDatabaseError(error, {
          feature: 'timeblock',
          operation: 'fetch_plan_template_activities',
        }),
      });
    }
    return new Set((data ?? []).filter((row) => row.archived_at != null).map((row) => row.id));
  }

  /** timezone / 既定長 / 直近 4 週の中央値。list と apply が同じ値を見る。 */
  private async loadDurationContext(userId: string, now = new Date()): Promise<DurationContext> {
    const { data: settings, error } = await this.supabase
      .from('user_settings')
      .select('timezone, default_duration')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      captureUnexpectedDatabaseError(error, {
        feature: 'timeblock',
        operation: 'fetch_plan_template_settings',
      });
    }
    const records = await fetchRecords(this.supabase, userId, {
      startDate: new Date(now.getTime() - MEDIAN_DURATION_WINDOW_DAYS * MS_PER_DAY).toISOString(),
      endDate: now.toISOString(),
    });
    return {
      timezone: settings?.timezone ?? 'UTC',
      defaultMinutes: settings?.default_duration ?? FALLBACK_DEFAULT_MINUTES,
      medianMinutesByActivity: aggregateActivityMedianDurations(records),
    };
  }
}

export function createPlanTemplateService(supabase: ServiceSupabaseClient): PlanTemplateService {
  return new PlanTemplateService(supabase);
}
