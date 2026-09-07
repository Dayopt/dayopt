/**
 * Activities Feature - Public API
 *
 * migration: supabase/migrations/20260818120000_add_activity_category_tables.sql
 *
 * Category / Activity 機能の統一的なエントリーポイント。
 * 外部からのインポートはこのファイル経由で行う。
 *
 * server 層（router / service）は app-router.ts からのみ import する
 * （barrel から export しない）。
 */

// Types
export type { Activity, ActivityTree, Category } from './types';

// 表示部品（色・アイコンを持つのはカテゴリーだけ。アクティビティは継承する）
export { ActivityIcon } from './components/ActivityIcon';
export {
  CategoryAppearancePickerRow,
  CategoryColorMenuItems,
  CategoryIconMenuItems,
} from './components/CategoryAppearanceMenuItems';

// 確認ダイアログ（作成 / 改名モーダルは Global ラッパー経由でだけ開くので barrel に出さない）
export { ActivityDeleteConfirmDialog } from './components/ActivityDeleteConfirmDialog';

// 選択ピッカー（Inspector / 作成ポップオーバー / インラインパレットから開く）
export { ActivityPickerList, ActivityQuickSelector } from './components/ActivityQuickSelector';
export type { HoveredActivityInfo } from './components/ActivityQuickSelector';

// 色・アイコンの解決
export { getCategoryColorClasses, resolveCategoryColor } from './lib/category-colors';
export type { CategoryColorName } from './lib/category-colors';

// 取得
export { useActivitiesMap } from './hooks/useActivitiesMap';
export {
  useActivities,
  useActivityTree,
  useArchivedActivities,
  useArchivedCategories,
} from './hooks/useActivitiesQuery';

// 更新（すべて楽観的更新つき）
export {
  useArchiveActivity,
  useCreateActivity,
  useDeleteActivity,
  useRestoreActivity,
  useUpdateActivity,
} from './hooks/useActivityMutations';
export {
  useArchiveCategory,
  useCreateCategory,
  useDeleteCategory,
  useRestoreCategory,
  useUpdateCategory,
} from './hooks/useCategoryMutations';

// tree の畳み込み（サイドバーのフィルター同期・同名衝突の検出に使う）
export {
  collectActivitiesFromTree,
  collectActivityIdsFromTree,
} from './domain/activity-tree-cache';

// ここにないものはfeature内部専用。
// useCreateCategory は外から要るようになった時点で足す。使う前に export すると
// knip が孤児として検出する。
