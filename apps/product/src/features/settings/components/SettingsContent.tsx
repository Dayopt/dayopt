'use client';

import { Suspense, lazy, useEffect } from 'react';

import { CACHE_5_MINUTES } from '@/lib/date';
import { api } from '@/lib/trpc';
import { Skeleton } from '@dayopt/components';

import type { SettingsCategory } from '../types';

const categoryComponents: Record<
  SettingsCategory,
  React.LazyExoticComponent<React.ComponentType<object>>
> = {
  display: lazy(() => import('./DisplaySettings').then((m) => ({ default: m.DisplaySettings }))),
  data: lazy(() => import('./DataSettings').then((m) => ({ default: m.DataSettings }))),
  integrations: lazy(() =>
    import('./IntegrationsSettings').then((m) => ({ default: m.IntegrationsSettings })),
  ),
  billing: lazy(() => import('./BillingSettings').then((m) => ({ default: m.BillingSettings }))),
  account: lazy(() => import('./AccountSettings').then((m) => ({ default: m.AccountSettings }))),
};

const VALID_CATEGORIES = new Set<string>(['display', 'data', 'integrations', 'billing', 'account']);

/**
 * 文字列が有効な設定カテゴリかチェックする型ガード
 * @param category - チェック対象の文字列
 */
export function isValidCategory(category: string): category is SettingsCategory {
  return VALID_CATEGORIES.has(category);
}

interface SettingsContentProps {
  category: SettingsCategory;
}

/**
 * 設定コンテンツエリア
 *
 * カテゴリに応じたコンポーネントを遅延読み込みで表示
 * ルーティングページとダイアログの両方で再利用
 */
export function SettingsContent({ category }: SettingsContentProps) {
  const CategoryComponent = categoryComponents[category];
  const utils = api.useUtils();

  // マウント時に設定データをプリフェッチ
  useEffect(() => {
    void utils.userSettings.get.prefetch(undefined, { staleTime: CACHE_5_MINUTES });
  }, [utils]);

  return (
    <div key={category} className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <Suspense fallback={<SettingsLoadingSkeleton />}>
        <CategoryComponent />
      </Suspense>
    </div>
  );
}

function SettingsLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-48" />
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
