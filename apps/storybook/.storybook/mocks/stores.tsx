/**
 * Storybook用 Zustand ストアモックシステム
 *
 * Story は parameters.storeMocks でストア状態を宣言的に指定できる。
 * 各Story実行前にスナップショットを取得し、unmount時に自動リストアする。
 *
 * @example
 * export const Authenticated: Story = {
 *   parameters: {
 *     storeMocks: {
 *       useAuthStore: { user: PRESET_AUTH.authenticatedUser, loading: false },
 *       useCalendarFilterStore: { initialized: true },
 *     },
 *   },
 * };
 */

import type { Decorator } from '@storybook/nextjs-vite';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand';

import { useAuthStore } from '@/features/auth';
import { useActivitySortStore } from '@/features/calendar/stores/useActivitySortStore';
import { useCalendarFilterStore } from '@/features/calendar/stores/useCalendarFilterStore';
import { useCalendarNavigationStore } from '@/features/calendar/stores/useCalendarNavigationStore';
import { useShellStore } from '@/lib/stores/useShellStore';

// ─────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────

/**
 * ストア名 → ストア参照のレジストリ
 * 新しいストアを追加する場合はここに登録する
 */
const STORE_REGISTRY: Record<string, StoreApi<Record<string, unknown>>> = {
  useActivitySortStore: useActivitySortStore as unknown as StoreApi<Record<string, unknown>>,
  useAuthStore: useAuthStore as unknown as StoreApi<Record<string, unknown>>,
  useCalendarFilterStore: useCalendarFilterStore as unknown as StoreApi<Record<string, unknown>>,
  useCalendarNavigationStore: useCalendarNavigationStore as unknown as StoreApi<
    Record<string, unknown>
  >,
  useShellStore: useShellStore as unknown as StoreApi<Record<string, unknown>>,
};

/** parameters.storeMocks の型 */
export type StoreMockOverrides = Record<string, Record<string, unknown>>;

// ─────────────────────────────────────────────────────────
// Wrapper Component
// ─────────────────────────────────────────────────────────

/**
 * ストアモックを適用するラッパーコンポーネント。
 * useEffect でスナップショット取得 → overrides適用 → クリーンアップでリストア。
 */
function StoreMockWrapper({
  overrides,
  children,
}: {
  overrides: StoreMockOverrides;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const snapshots: Array<[StoreApi<Record<string, unknown>>, Record<string, unknown>]> = [];

    for (const [key, values] of Object.entries(overrides)) {
      const store = STORE_REGISTRY[key];
      if (store) {
        snapshots.push([store, store.getState()]);
        store.setState(values);
      }
    }

    return () => {
      for (const [store, snapshot] of snapshots) {
        store.setState(snapshot, true);
      }
    };
  }, [overrides]);

  return <>{children}</>;
}

// ─────────────────────────────────────────────────────────
// Decorator
// ─────────────────────────────────────────────────────────

/**
 * parameters.storeMocks を読み取り、ストア状態を設定するデコレータ。
 */
export const storeMockDecorator: Decorator = (Story, context) => {
  const overrides = context.parameters.storeMocks as StoreMockOverrides | undefined;

  if (!overrides) {
    return <Story />;
  }

  return (
    <StoreMockWrapper overrides={overrides}>
      <Story />
    </StoreMockWrapper>
  );
};
