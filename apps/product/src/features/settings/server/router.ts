/**
 * tRPC Router: UserSettings
 * ユーザー設定管理API（カレンダー設定等）
 */

import { SUPPORTED_LOCALES } from '@dayopt/config';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { AnalyticsConsentService } from './analytics-consent-service';
import { createSettingsService } from './settings-service';

// バリデーションスキーマ
const userSettingsSchema = z.object({
  // タイムゾーン設定
  timezone: z.string().optional(),
  // 時間表示形式
  timeFormat: z.enum(['24h', '12h']).optional(),

  // 週の設定
  weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional(),
  showWeekends: z.boolean().optional(),
  showWeekNumbers: z.boolean().optional(),

  // タスク設定
  defaultDuration: z.number().min(5).max(480).optional(),

  // デフォルトビュー・密度（Settings = デフォルト、Header = セッション）
  defaultView: z.enum(['day', '3day', '5day', 'week']).optional(),
  hourHeightDensity: z.enum(['compact', 'default', 'spacious']).optional(),

  // テーマ設定
  theme: z.enum(['light', 'dark', 'system']).optional(),

  // ダイアログ表示済みフラグ
  dismissedTrialEndedDialog: z.literal(true).optional(),
  paymentErrorDialogLastShownAt: z.string().datetime().optional(),

  // メール送信言語
  preferredLocale: z.enum(SUPPORTED_LOCALES).optional(),
});

const profileUpdateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(100).optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
  })
  .refine((input) => input.fullName !== undefined || input.avatarUrl !== undefined, {
    message: 'At least one profile field is required',
  });

/** ユーザー設定のtRPCルーター（取得・更新・iCalトークン管理） */
export const userSettingsRouter = createTRPCRouter({
  getAnalyticsConsent: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await new AnalyticsConsentService(ctx.supabase).get(ctx.userId!);
    } catch (error) {
      return handleServiceError(error);
    }
  }),

  setAnalyticsConsent: protectedProcedure
    .input(z.object({ allowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await new AnalyticsConsentService(ctx.supabase).set(ctx.userId!, input.allowed);
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  /**
   * 設定取得
   */
  get: protectedProcedure
    .meta({ description: 'ユーザー設定取得（カレンダー・表示等）' })
    .query(async ({ ctx }) => {
      try {
        const userId = ctx.userId;

        if (!userId) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User ID not found',
          });
        }

        return await createSettingsService(ctx.supabase).get(userId);
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  /**
   * 設定更新（upsert）
   */
  update: protectedProcedure
    .meta({ description: 'ユーザー設定更新（upsert）' })
    .input(userSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = ctx.userId;

        if (!userId) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User ID not found',
          });
        }

        return await createSettingsService(ctx.supabase).update(userId, input);
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  updateProfile: protectedProcedure
    .meta({ description: 'プロフィール表示情報更新' })
    .input(profileUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createSettingsService(ctx.supabase).updateProfile(ctx.userId, input);
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  /**
   * iCalフィードトークン取得
   *
   * NOTE: ical_feed_tokenカラムはマイグレーション後に追加されるため、
   * 生成型にはまだ含まれていない。RPC経由で直接SQLを実行。
   */
  getICalToken: protectedProcedure
    .meta({ description: 'iCalフィードトークン取得' })
    .query(async ({ ctx }) => {
      try {
        const userId = ctx.userId;

        if (!userId) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User ID not found',
          });
        }

        return await createSettingsService(ctx.supabase).getICalToken(userId);
      } catch (error) {
        return handleServiceError(error);
      }
    }),

  /**
   * iCalフィードトークン再生成
   */
  regenerateICalToken: protectedProcedure
    .meta({ description: 'iCalフィードトークン再生成' })
    .mutation(async ({ ctx }) => {
      try {
        const userId = ctx.userId;

        if (!userId) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User ID not found',
          });
        }

        return await createSettingsService(ctx.supabase).regenerateICalToken(userId);
      } catch (error) {
        return handleServiceError(error);
      }
    }),
});
