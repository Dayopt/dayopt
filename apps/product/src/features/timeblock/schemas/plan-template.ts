import { z } from 'zod';

import { isValidTemplateDateKey } from '../domain/plan-template-anchor';

/** テンプレート名。DB の `plan_templates_name_length`（btrim > 0、<= 100）と同じ境界。 */
const templateNameSchema = z
  .string()
  .trim()
  .min(1, 'validation.title.required')
  .max(100, 'validation.title.maxLength');

/** yyyy-MM-dd（ユーザー timezone の暦日）。 */
const dateKeySchema = z.string().refine(isValidTemplateDateKey, 'validation.invalidDate');

/**
 * 保存するブロック。組成（activity / title）と錨位置だけで、寸法は持たない（v1.0 §5.4）。
 * `anchorMinute` は DB の CHECK（0..1439）と同じ境界。
 */
const planTemplateBlockDraftSchema = z.object({
  activityId: z.string().uuid().nullable(),
  title: z
    .string()
    .trim()
    .min(1, 'validation.title.required')
    .max(200, 'validation.title.maxLength'),
  anchorMinute: z.number().int().min(0).max(1439),
});

/** 1 template あたりのブロック上限。bulk command（50 件で 22023）と揃える。 */
const MAX_PLAN_TEMPLATE_BLOCKS = 50;

export const createPlanTemplateSchema = z.object({
  name: templateNameSchema,
  blocks: z.array(planTemplateBlockDraftSchema).min(1).max(MAX_PLAN_TEMPLATE_BLOCKS),
});

export const planTemplateIdSchema = z.object({
  templateId: z.string().uuid('validation.invalidUuid'),
});

export const renamePlanTemplateSchema = planTemplateIdSchema.extend({
  name: templateNameSchema,
});

export const applyPlanTemplateSchema = planTemplateIdSchema.extend({
  date: dateKeySchema,
});

export type CreatePlanTemplateInput = z.infer<typeof createPlanTemplateSchema>;
export type RenamePlanTemplateInput = z.infer<typeof renamePlanTemplateSchema>;
export type ApplyPlanTemplateInput = z.infer<typeof applyPlanTemplateSchema>;
export type PlanTemplateIdInput = z.infer<typeof planTemplateIdSchema>;
