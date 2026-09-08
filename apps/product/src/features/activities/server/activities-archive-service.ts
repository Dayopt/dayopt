import { createServiceRoleClient } from '@/lib/supabase/oauth';
import 'server-only';

import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Activity, Category } from '../types';
import type { ActivitiesQueryService } from './activities-query-service';
import { transformDbActivity, transformDbCategory } from './activity-row-transform';
import {
  ActivitiesServiceError,
  createActivitiesDatabaseError,
  isUniqueViolation,
} from './activity-service-error';

/**
 * Category / Activity のアーカイブ / 復元。
 *
 * tags と異なり親子の道連れは無い（カテゴリーをアーカイブしても所属
 * activity は自動アーカイブされない。カテゴリー削除時と違い、アーカイブは
 * 破壊的操作ではないため、活動側は独立して残る仕様とする）。
 */
export class ActivitiesArchiveService {
  constructor(
    _supabase: SupabaseClient<Database>,
    private readonly queryService: ActivitiesQueryService,
  ) {}

  async archiveCategory(options: { userId: string; categoryId: string }): Promise<Category> {
    const { userId, categoryId } = options;
    const category = await this.queryService.getCategoryById({
      userId,
      categoryId,
      includeArchived: true,
    });
    if (category.archived_at) return category;

    const archivedAt = new Date().toISOString();
    const { data, error } = await createServiceRoleClient()
      .from('categories')
      .update({ archived_at: archivedAt })
      .eq('id', categoryId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to archive category',
        'archive_category',
      );
    }
    return transformDbCategory(data);
  }

  async restoreCategory(options: { userId: string; categoryId: string }): Promise<Category> {
    const { userId, categoryId } = options;
    const category = await this.queryService.getCategoryById({
      userId,
      categoryId,
      includeArchived: true,
    });
    if (!category.archived_at) return category;

    const { data, error } = await createServiceRoleClient()
      .from('categories')
      .update({ archived_at: null })
      .eq('id', categoryId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'A category with the same name already exists',
        );
      }
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to restore category',
        'restore_category',
      );
    }
    return transformDbCategory(data);
  }

  async archiveActivity(options: { userId: string; activityId: string }): Promise<Activity> {
    const { userId, activityId } = options;
    const activity = await this.queryService.getActivityById({
      userId,
      activityId,
      includeArchived: true,
    });
    if (activity.archived_at) return activity;

    const archivedAt = new Date().toISOString();
    const { data, error } = await createServiceRoleClient()
      .from('activities')
      .update({ archived_at: archivedAt })
      .eq('id', activityId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to archive activity',
        'archive_activity',
      );
    }
    return transformDbActivity(data);
  }

  async restoreActivity(options: { userId: string; activityId: string }): Promise<Activity> {
    const { userId, activityId } = options;
    const activity = await this.queryService.getActivityById({
      userId,
      activityId,
      includeArchived: true,
    });
    if (!activity.archived_at) return activity;

    const { data, error } = await createServiceRoleClient()
      .from('activities')
      .update({ archived_at: null })
      .eq('id', activityId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'An activity with the same name already exists',
        );
      }
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to restore activity',
        'restore_activity',
      );
    }
    return transformDbActivity(data);
  }
}
