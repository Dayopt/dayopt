import { createServiceRoleClient } from '@/lib/supabase/oauth';
import 'server-only';

import type { Database, Insert, Update } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Activity, Category } from '../types';
import type { ActivitiesQueryService } from './activities-query-service';
import { transformDbActivity, transformDbCategory } from './activity-row-transform';
import {
  ActivitiesServiceError,
  createActivitiesDatabaseError,
  isForeignKeyViolation,
  isUniqueViolation,
} from './activity-service-error';

const CATEGORY_COLORS = [
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
] as const;

export interface CreateCategoryInput {
  name: string;
  color?: (typeof CATEGORY_COLORS)[number] | undefined;
  icon?: string | undefined;
}

export interface UpdateCategoryInput {
  name?: string | undefined;
  color?: (typeof CATEGORY_COLORS)[number] | null | undefined;
  icon?: string | null | undefined;
}

export interface CreateActivityInput {
  name: string;
  categoryId?: string | null | undefined;
}

export interface UpdateActivityInput {
  name?: string | undefined;
  categoryId?: string | null | undefined;
}

function assertValidName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ActivitiesServiceError('INVALID_INPUT', 'Name is required');
  }
  if (trimmed.length > 50) {
    throw new ActivitiesServiceError('INVALID_INPUT', 'Name must be 50 characters or less');
  }
  return trimmed;
}

/**
 * Category / Activity の作成・更新ロジック。
 *
 * tags と異なり階層検証（親の深さ・子の有無）は無い。category_id の所有者整合は
 * 複合 FK が担保するため、ここでは「存在するか」（NOT_FOUND / FK 違反）だけを見る。
 */
export class ActivitiesMutationService {
  constructor(
    _supabase: SupabaseClient<Database>,
    private readonly queryService: ActivitiesQueryService,
  ) {}

  async createCategory(options: { userId: string; input: CreateCategoryInput }): Promise<Category> {
    const { userId, input } = options;
    const name = assertValidName(input.name);

    const categoryData: Insert<'categories'> = {
      user_id: userId,
      name,
      color: input.color ?? null,
      icon: input.icon ?? null,
    };

    const { data, error } = await createServiceRoleClient()
      .from('categories')
      .insert(categoryData)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'Category with this name already exists',
        );
      }
      throw createActivitiesDatabaseError(
        error,
        'CREATE_FAILED',
        'Failed to create category',
        'create_category',
      );
    }

    return transformDbCategory(data);
  }

  async updateCategory(options: {
    userId: string;
    categoryId: string;
    updates: UpdateCategoryInput;
  }): Promise<Category> {
    const { userId, categoryId, updates } = options;
    // 所有権チェック（無ければ NOT_FOUND になる）
    await this.queryService.getCategoryById({ userId, categoryId, includeArchived: true });

    const updateData: Update<'categories'> = {};
    if (updates.name !== undefined) updateData.name = assertValidName(updates.name);
    if (updates.color !== undefined) updateData.color = updates.color;
    if (updates.icon !== undefined) updateData.icon = updates.icon;

    const { data, error } = await createServiceRoleClient()
      .from('categories')
      .update(updateData)
      .eq('id', categoryId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'Category with this name already exists',
        );
      }
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to update category',
        'update_category',
      );
    }

    return transformDbCategory(data);
  }

  async createActivity(options: { userId: string; input: CreateActivityInput }): Promise<Activity> {
    const { userId, input } = options;
    const name = assertValidName(input.name);
    const categoryId = input.categoryId ?? null;

    if (categoryId) {
      // アーカイブ済みカテゴリーへの新規割当は禁止する（未分類へ落とすのは
      // カテゴリー削除時の FK SET NULL のみが担う経路にする）。
      const category = await this.queryService.getCategoryById({
        userId,
        categoryId,
        includeArchived: true,
      });
      if (category.archived_at) {
        throw new ActivitiesServiceError(
          'INVALID_INPUT',
          'Cannot assign an activity to an archived category',
        );
      }
    }

    const activityData: Insert<'activities'> = {
      user_id: userId,
      name,
      category_id: categoryId,
    };

    const { data, error } = await createServiceRoleClient()
      .from('activities')
      .insert(activityData)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'Activity with this name already exists',
        );
      }
      if (isForeignKeyViolation(error)) {
        throw new ActivitiesServiceError('NOT_FOUND', `Category not found: ${categoryId}`);
      }
      throw createActivitiesDatabaseError(
        error,
        'CREATE_FAILED',
        'Failed to create activity',
        'create_activity',
      );
    }

    return transformDbActivity(data);
  }

  async updateActivity(options: {
    userId: string;
    activityId: string;
    updates: UpdateActivityInput;
  }): Promise<Activity> {
    const { userId, activityId, updates } = options;
    // 所有権チェック（無ければ NOT_FOUND になる）
    await this.queryService.getActivityById({ userId, activityId, includeArchived: true });

    const updateData: Update<'activities'> = {};
    if (updates.name !== undefined) updateData.name = assertValidName(updates.name);

    if (updates.categoryId !== undefined) {
      const nextCategoryId = updates.categoryId;
      if (nextCategoryId) {
        const category = await this.queryService.getCategoryById({
          userId,
          categoryId: nextCategoryId,
          includeArchived: true,
        });
        if (category.archived_at) {
          throw new ActivitiesServiceError(
            'INVALID_INPUT',
            'Cannot move an activity into an archived category',
          );
        }
      }
      updateData.category_id = nextCategoryId;
    }

    const { data, error } = await createServiceRoleClient()
      .from('activities')
      .update(updateData)
      .eq('id', activityId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new ActivitiesServiceError(
          'DUPLICATE_NAME',
          'Activity with this name already exists',
        );
      }
      if (isForeignKeyViolation(error)) {
        throw new ActivitiesServiceError('NOT_FOUND', `Category not found: ${updates.categoryId}`);
      }
      throw createActivitiesDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to update activity',
        'update_activity',
      );
    }

    return transformDbActivity(data);
  }
}
