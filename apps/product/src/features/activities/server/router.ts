/**
 * Activities tRPC Router
 *
 * Category / Activity 管理の tRPC エンドポイント。
 *
 * エンドポイント:
 * - activities.listCategories: カテゴリー一覧取得
 * - activities.createCategory: カテゴリー作成
 * - activities.updateCategory: カテゴリー更新（名前・色・アイコン）
 * - activities.archiveCategory: カテゴリーアーカイブ
 * - activities.restoreCategory: アーカイブ済みカテゴリーの復元
 * - activities.deleteCategory: カテゴリー削除（所属 Activity は FK で未分類化）
 * - activities.listActivities: アクティビティ一覧取得
 * - activities.createActivity: アクティビティ作成
 * - activities.updateActivity: アクティビティ更新（名前・所属カテゴリー）
 * - activities.archiveActivity: アクティビティアーカイブ
 * - activities.restoreActivity: アーカイブ済みアクティビティの復元
 * - activities.deleteActivity: アクティビティ削除
 * - activities.listTree: サイドバー用スナップショット（カテゴリー + 所属 Activity + 未分類）
 */

import { z } from 'zod';

import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { createActivitiesService } from './activities-service';
import { createActivitySummaryService } from './activity-summary-service';

const CATEGORY_COLOR = z.enum([
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
  'gray',
]);

const ICON_NAME = z
  .string()
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/);

const NAME = z.string().min(1).max(50);
const TIMEZONE = z.string().min(1).max(64);

export const activitiesRouter = createTRPCRouter({
  getActivitySummary: protectedProcedure
    .meta({ description: '直近30日間のアクティビティ記録サマリー' })
    .input(z.object({ activityId: z.string().uuid(), timezone: TIMEZONE }))
    .query(async ({ ctx, input }) => {
      try {
        return await createActivitySummaryService(ctx.supabase).getActivitySummary(
          ctx.userId,
          input,
        );
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  // ----- Categories -----

  listCategories: protectedProcedure
    .meta({ description: 'カテゴリー一覧取得' })
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.listCategories({
          userId: ctx.userId,
          includeArchived: input?.includeArchived,
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  createCategory: protectedProcedure
    .meta({ description: 'カテゴリー作成' })
    .input(
      z.object({
        name: NAME,
        color: CATEGORY_COLOR.optional(),
        icon: ICON_NAME.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.createCategory({
          userId: ctx.userId,
          input: { name: input.name, color: input.color, icon: input.icon },
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  updateCategory: protectedProcedure
    .meta({ description: 'カテゴリー更新（名前・色・アイコン）' })
    .input(
      z.object({
        id: z.string().uuid(),
        name: NAME.optional(),
        color: CATEGORY_COLOR.nullable().optional(),
        icon: ICON_NAME.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.updateCategory({
          userId: ctx.userId,
          categoryId: input.id,
          updates: { name: input.name, color: input.color, icon: input.icon },
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  archiveCategory: protectedProcedure
    .meta({ description: 'カテゴリーアーカイブ' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.archiveCategory({ userId: ctx.userId, categoryId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  restoreCategory: protectedProcedure
    .meta({ description: 'アーカイブ済みカテゴリーの復元' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.restoreCategory({ userId: ctx.userId, categoryId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  deleteCategory: protectedProcedure
    .meta({ description: 'カテゴリー削除（所属 Activity は未分類化して残す）' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.deleteCategory({ userId: ctx.userId, categoryId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  // ----- Activities -----

  listActivities: protectedProcedure
    .meta({ description: 'アクティビティ一覧取得' })
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.listActivities({
          userId: ctx.userId,
          includeArchived: input?.includeArchived,
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  createActivity: protectedProcedure
    .meta({ description: 'アクティビティ作成' })
    .input(
      z.object({
        name: NAME,
        categoryId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.createActivity({
          userId: ctx.userId,
          input: { name: input.name, categoryId: input.categoryId },
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  updateActivity: protectedProcedure
    .meta({ description: 'アクティビティ更新（名前・所属カテゴリー）' })
    .input(
      z.object({
        id: z.string().uuid(),
        name: NAME.optional(),
        categoryId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.updateActivity({
          userId: ctx.userId,
          activityId: input.id,
          updates: { name: input.name, categoryId: input.categoryId },
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  archiveActivity: protectedProcedure
    .meta({ description: 'アクティビティアーカイブ' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.archiveActivity({ userId: ctx.userId, activityId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  restoreActivity: protectedProcedure
    .meta({ description: 'アーカイブ済みアクティビティの復元' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.restoreActivity({ userId: ctx.userId, activityId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  deleteActivity: protectedProcedure
    .meta({ description: 'アクティビティ削除' })
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.deleteActivity({ userId: ctx.userId, activityId: input.id });
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  // ----- Tree -----

  listTree: protectedProcedure
    .meta({ description: 'サイドバー用スナップショット（カテゴリー + 所属 Activity + 未分類）' })
    .query(async ({ ctx }) => {
      try {
        const service = createActivitiesService(ctx.supabase);
        return await service.listTree({ userId: ctx.userId });
      } catch (error) {
        return handleServiceError(error);
      }
    }),
});
