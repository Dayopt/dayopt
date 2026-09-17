'use client';

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import type { SettingsCategory } from '@/lib/types/settings';
import { createSelectors } from '@/lib/zustand/createSelectors';
import { platformStorage } from '@/lib/zustand/storage';

// ── Sheet Types ──

/** アクティビティ改名モーダルで渡す対象の identity */
export interface ActivityRenameTarget {
  id: string;
  name: string;
}

/** カテゴリー改名モーダルで渡す対象の identity */
export interface CategoryRenameTarget {
  id: string;
  name: string;
}

/**
 * アクティビティ作成 modal の onCreated に渡される最小限の情報
 * （feature 依存を避ける plain shape）。
 */
export interface CreatedActivityPayload {
  id: string;
  name: string;
  categoryId: string | null;
}

/**
 * アクティビティ作成モーダルの context。
 * `onCreated` は serializable ではないため persist には乗せない（partialize で除外済）。
 */
export interface ActivityCreateContext {
  /** 初期選択カテゴリー（null = 未分類） */
  initialCategoryId: string | null;
  /**
   * 作成成功時のコールバック。caller が selection 反映や後続処理を行うのに使う。
   */
  onCreated?: (activity: CreatedActivityPayload) => void;
}

/**
 * シェルレベルのシート/ダイアログ（排他: 1つしか開かない）
 *
 * `contact` / `settings` は Sheet 系、`activityCreate` / `activityRename` /
 * `categoryRename` は Modal 系だが、shell 全体で「1 つしか開かない overlay」として
 * 統一管理する（旧 useModalStore を統合、P2-2）。
 *
 * アクティビティの統合（マージ）は v1 で持たない（#2162 §4-8）。重複は改名 +
 * アーカイブで代替するため、統合用の sheet も置かない。
 */
type SheetType =
  | { type: 'contact' }
  | { type: 'settings'; category: SettingsCategory }
  | { type: 'timeblockSearch' }
  | { type: 'shortcutCheatSheet' }
  | { type: 'activityCreate'; context: ActivityCreateContext }
  | { type: 'activityRename'; activity: ActivityRenameTarget }
  | { type: 'categoryRename'; category: CategoryRenameTarget };

// ── State ──

interface ShellStoreState {
  /** サイドバー状態 */
  sidebar: {
    /** 開閉状態 */
    open: boolean;
    /** 幅（px）。将来のリサイズ対応用 */
    width: number;
  };

  /** Calendar rail の表示領域を確保するための一時的な非表示状態（persist 対象外） */
  sidebarSuppressed: boolean;

  /** ページタイトル（PageHeaderで表示） */
  pageTitle: string;

  /** アクティブなシート/ダイアログ（null = 全て閉じている） */
  activeSheet: SheetType | null;
}

// ── Actions ──

interface ShellStoreActions {
  // Sidebar
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  suppressSidebar: () => void;
  restoreSidebar: () => void;

  // Page title
  setPageTitle: (title: string) => void;
  clearPageTitle: () => void;

  // Sheets
  openSheet: (sheet: SheetType) => void;
  closeSheet: () => void;

  // Timeblock search convenience
  openTimeblockSearch: () => void;
  closeTimeblockSearch: () => void;

  // Settings convenience（既存APIとの互換性）
  openSettings: (category?: SettingsCategory) => void;
  closeSettings: () => void;
  setSettingsCategory: (category: SettingsCategory) => void;

  // Activity create modal convenience
  openActivityCreateModal: (context?: Partial<ActivityCreateContext>) => void;
  closeActivityCreateModal: () => void;

  // Activity rename modal convenience
  openActivityRenameModal: (activity: ActivityRenameTarget) => void;
  closeActivityRenameModal: () => void;

  // Category rename modal convenience
  openCategoryRenameModal: (category: CategoryRenameTarget) => void;
  closeCategoryRenameModal: () => void;
}

// ── Store ──

const DEFAULT_SIDEBAR_WIDTH = 256;

const useShellStoreBase = create<ShellStoreState & ShellStoreActions>()(
  devtools(
    persist(
      (set, get) => ({
        // ── Initial State ──
        sidebar: {
          open: true,
          width: DEFAULT_SIDEBAR_WIDTH,
        },
        sidebarSuppressed: false,
        pageTitle: '',
        activeSheet: null,

        // ── Sidebar Actions ──
        openSidebar: () =>
          set((state) => ({ sidebar: { ...state.sidebar, open: true } }), false, 'openSidebar'),
        closeSidebar: () =>
          set((state) => ({ sidebar: { ...state.sidebar, open: false } }), false, 'closeSidebar'),
        toggleSidebar: () =>
          set(
            (state) => ({ sidebar: { ...state.sidebar, open: !state.sidebar.open } }),
            false,
            'toggleSidebar',
          ),
        setSidebarWidth: (width) =>
          set((state) => ({ sidebar: { ...state.sidebar, width } }), false, 'setSidebarWidth'),
        suppressSidebar: () => set({ sidebarSuppressed: true }, false, 'suppressSidebar'),
        restoreSidebar: () => set({ sidebarSuppressed: false }, false, 'restoreSidebar'),

        // ── Page Title Actions ──
        setPageTitle: (title) => set({ pageTitle: title }, false, 'setPageTitle'),
        clearPageTitle: () => set({ pageTitle: '' }, false, 'clearPageTitle'),

        // ── Sheet Actions ──
        openSheet: (sheet) => set({ activeSheet: sheet }, false, 'openSheet'),
        closeSheet: () => set({ activeSheet: null }, false, 'closeSheet'),

        // ── Timeblock Search Convenience ──
        openTimeblockSearch: () =>
          set({ activeSheet: { type: 'timeblockSearch' } }, false, 'openTimeblockSearch'),
        closeTimeblockSearch: () => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'timeblockSearch') {
            set({ activeSheet: null }, false, 'closeTimeblockSearch');
          }
        },

        // ── Settings Convenience ──
        openSettings: (category = 'account') =>
          set({ activeSheet: { type: 'settings', category } }, false, 'openSettings'),
        closeSettings: () => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'settings') {
            set({ activeSheet: null }, false, 'closeSettings');
          }
        },
        setSettingsCategory: (category) => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'settings') {
            set({ activeSheet: { type: 'settings', category } }, false, 'setSettingsCategory');
          }
        },

        // ── Activity Create Modal Convenience ──
        openActivityCreateModal: (context) =>
          set(
            {
              activeSheet: {
                type: 'activityCreate',
                context: {
                  initialCategoryId: context?.initialCategoryId ?? null,
                  ...(context?.onCreated ? { onCreated: context.onCreated } : {}),
                },
              },
            },
            false,
            'openActivityCreateModal',
          ),
        closeActivityCreateModal: () => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'activityCreate') {
            set({ activeSheet: null }, false, 'closeActivityCreateModal');
          }
        },

        // ── Activity Rename Modal Convenience ──
        openActivityRenameModal: (activity) =>
          set(
            { activeSheet: { type: 'activityRename', activity } },
            false,
            'openActivityRenameModal',
          ),
        closeActivityRenameModal: () => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'activityRename') {
            set({ activeSheet: null }, false, 'closeActivityRenameModal');
          }
        },

        // ── Category Rename Modal Convenience ──
        openCategoryRenameModal: (category) =>
          set(
            { activeSheet: { type: 'categoryRename', category } },
            false,
            'openCategoryRenameModal',
          ),
        closeCategoryRenameModal: () => {
          const { activeSheet } = get();
          if (activeSheet?.type === 'categoryRename') {
            set({ activeSheet: null }, false, 'closeCategoryRenameModal');
          }
        },
      }),
      {
        name: 'shell-storage',
        storage: platformStorage(),
        partialize: (state) => ({
          sidebar: state.sidebar,
        }),
      },
    ),
    { name: 'shell-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);

/**
 * シェルUI状態を統合管理するZustandストア
 *
 * 統合対象: useLayoutStore + usePageTitleStore + useContactStore + useSettingsStore
 *
 * @example
 * ```tsx
 * // Sidebar
 * const isSidebarOpen = useShellStore.use.sidebar().open;
 * const toggleSidebar = useShellStore.use.toggleSidebar();
 *
 * // Page title
 * const pageTitle = useShellStore.use.pageTitle();
 *
 * // Sheets
 * const activeSheet = useShellStore.use.activeSheet();
 * const openSettings = useShellStore.use.openSettings();
 * ```
 */
export const useShellStore = createSelectors(useShellStoreBase);
