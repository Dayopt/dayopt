/**
 * Category / Activity の 3 キャッシュ（listTree / listActivities / listCategories）を
 * まとめて操作するヘルパー。
 *
 * **3 本すべてを同じ mutation で更新する。** 片方だけ楽観更新すると、`onSettled` の
 * invalidate → refetch で更新が巻き戻ったように見える（旧 tags 実装の
 * `useTagCrudMutations.ts` が同じ罠をコメントで記録している）。
 *
 * hook ではないので、呼び出し側が `trpc.useUtils()` の戻り値を渡す。
 */

import { trpc } from '@/lib/trpc/client';
import {
  removeActivityFromTree,
  removeCategoryFromTree,
  upsertActivityInTree,
  upsertCategoryInTree,
} from '../domain/activity-tree-cache';
import type { Activity, Category } from '../types';
import { ACTIVITY_LIST_INPUT, CATEGORY_LIST_INPUT } from './useActivitiesQuery';

type ActivitiesUtils = Pick<
  ReturnType<typeof trpc.useUtils>,
  'activities' | 'plans' | 'records' | 'statistics' | 'review'
>;

/** ロールバック用のスナップショット */
interface ActivitiesSnapshot {
  restore: () => void;
}

/**
 * 3 キャッシュを止めて現在値を控える。
 *
 * mutation 中に走っている refetch が楽観更新を上書きしないよう、`cancel` を必ず通す。
 */
export async function snapshotActivityCaches(utils: ActivitiesUtils): Promise<ActivitiesSnapshot> {
  await Promise.all([
    utils.activities.listTree.cancel(),
    utils.activities.listActivities.cancel(ACTIVITY_LIST_INPUT),
    utils.activities.listCategories.cancel(CATEGORY_LIST_INPUT),
  ]);

  const tree = utils.activities.listTree.getData();
  const activities = utils.activities.listActivities.getData(ACTIVITY_LIST_INPUT);
  const categories = utils.activities.listCategories.getData(CATEGORY_LIST_INPUT);

  return {
    restore: () => {
      utils.activities.listTree.setData(undefined, tree);
      utils.activities.listActivities.setData(ACTIVITY_LIST_INPUT, activities);
      utils.activities.listCategories.setData(CATEGORY_LIST_INPUT, categories);
    },
  };
}

/** キャッシュ済みのアクティビティを 1 件読む（楽観的更新の元にする） */
export function readActivityFromCaches(
  utils: ActivitiesUtils,
  activityId: string,
): Activity | undefined {
  return utils.activities.listActivities
    .getData(ACTIVITY_LIST_INPUT)
    ?.find((activity) => activity.id === activityId);
}

/** キャッシュ済みのカテゴリーを 1 件読む */
export function readCategoryFromCaches(
  utils: ActivitiesUtils,
  categoryId: string,
): Category | undefined {
  return utils.activities.listCategories
    .getData(CATEGORY_LIST_INPUT)
    ?.find((category) => category.id === categoryId);
}

function upsertInList<T extends { id: string }>(
  list: T[] | undefined,
  item: T,
  replaceId?: string,
): T[] | undefined {
  if (!list) return list;
  const index = list.findIndex(
    (candidate) =>
      candidate.id === item.id || (replaceId !== undefined && candidate.id === replaceId),
  );
  if (index >= 0) {
    return list.map((candidate, position) => (position === index ? item : candidate));
  }
  return [...list, item];
}

/** アクティビティの作成・更新・アーカイブ・復元を 3 キャッシュへ反映する */
export function writeActivityToCaches(
  utils: ActivitiesUtils,
  activity: Activity,
  replaceId?: string,
): void {
  utils.activities.listActivities.setData(ACTIVITY_LIST_INPUT, (old) =>
    upsertInList(old, activity, replaceId),
  );
  utils.activities.listTree.setData(undefined, (old) =>
    upsertActivityInTree(old, activity, replaceId),
  );
}

/** アクティビティの削除を 3 キャッシュへ反映する */
export function deleteActivityFromCaches(utils: ActivitiesUtils, activityId: string): void {
  utils.activities.listActivities.setData(ACTIVITY_LIST_INPUT, (old) =>
    old?.filter((activity) => activity.id !== activityId),
  );
  utils.activities.listTree.setData(undefined, (old) => removeActivityFromTree(old, activityId));
}

/**
 * カテゴリーの作成・更新・アーカイブ・復元を 3 キャッシュへ反映する。
 *
 * アーカイブ時に所属アクティビティを未分類へ移す処理は
 * `upsertCategoryInTree` 側が持つ（サーバーの配置規則と同じ）。
 */
export function writeCategoryToCaches(
  utils: ActivitiesUtils,
  category: Category,
  replaceId?: string,
): void {
  utils.activities.listCategories.setData(CATEGORY_LIST_INPUT, (old) =>
    upsertInList(old, category, replaceId),
  );
  utils.activities.listTree.setData(undefined, (old) =>
    upsertCategoryInTree(old, category, replaceId),
  );
}

/**
 * カテゴリーの削除を 3 キャッシュへ反映する。
 *
 * 所属アクティビティは削除せず未分類へ移す（複合 FK の
 * `ON DELETE SET NULL (category_id)` と同じ見え方）。`listActivities` 側の
 * `category_id` も null へ落とさないと、tree と一覧で所属が食い違う。
 */
export function deleteCategoryFromCaches(utils: ActivitiesUtils, categoryId: string): void {
  utils.activities.listCategories.setData(CATEGORY_LIST_INPUT, (old) =>
    old?.filter((category) => category.id !== categoryId),
  );
  utils.activities.listActivities.setData(ACTIVITY_LIST_INPUT, (old) =>
    old?.map((activity) =>
      activity.category_id === categoryId ? { ...activity, category_id: null } : activity,
    ),
  );
  utils.activities.listTree.setData(undefined, (old) => removeCategoryFromTree(old, categoryId));
}

/**
 * 分類一覧と、その名前・所属・アーカイブ状態を持つレポートを再取得する。
 * レポートは独立したキャッシュなので、一覧だけ更新しても表示やフィルタが古いまま残る。
 * アーカイブの取り消しもこの経路を通す。
 */
export function invalidateActivityCaches(utils: ActivitiesUtils): void {
  void utils.activities.listTree.invalidate();
  void utils.activities.listActivities.invalidate();
  void utils.activities.listCategories.invalidate();
  void utils.review.invalidate();
}

/** アクティビティの割り当てが変わる操作の後始末（予定・記録の表示と集計も動く） */
export function invalidateActivityAssignments(utils: ActivitiesUtils): void {
  invalidateActivityCaches(utils);
  void utils.plans.list.invalidate();
  void utils.records.list.invalidate();
  void utils.statistics.invalidate();
}
