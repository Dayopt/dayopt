/**
 * カレンダー表示フィルターストア
 *
 * サイドバーのアクティビティ一覧と連動し、カレンダー上の表示/非表示を切り替える。
 *
 * **アクティビティ未設定のブロックは常に表示する。** サイドバーに「アクティビティなし」
 * のフィルタ行を置かない確定（2026-08-18 User 指示）に伴い、対応する state も持たない。
 * state だけ残すと「UI から戻せないのに非表示のまま」という復帰不能な状態を作れてしまう。
 *
 * ここでの「未分類」はカテゴリーに所属していないアクティビティ（サイドバーの見出し）を指す。
 * アクティビティが設定されていないブロックは別概念で、語彙を混ぜない。
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { createPlatformStorage } from '@/lib/zustand/storage';

/** カレンダーフィルターの状態インターフェース */
interface CalendarFilterState {
  /** アクティビティIDごとの表示設定（デフォルト: すべて表示） */
  visibleActivityIds: Set<string>;

  /** 初期化済みフラグ（アクティビティ一覧取得後に初期化） */
  initialized: boolean;

  /**
   * `syncWithActivities` が最後に認識した全アクティビティ ID（アーカイブ済み含む）の集合。
   *
   * `visibleActivityIds` だけでは「新規アクティビティ」と「意図的に非表示にしたもの」を
   * 区別できず、「このアクティビティだけ表示」等で絞り込んだ直後に sync が走ると全アクティビティが
   * 「新規」と誤認されて復活してしまう（#1576フォローアップ）。この集合を既知の基準に
   * することで区別する。`syncWithActivities` 以外のアクションでは更新しない。
   */
  knownActivityIds: Set<string>;
}

/** カレンダーフィルターのアクションインターフェース */
interface CalendarFilterActions {
  /** アクティビティの表示切替 */
  toggleActivity: (activityId: string) => void;

  /** すべてのアクティビティを表示 */
  showAllActivities: (activityIds: string[]) => void;

  /** すべてのアクティビティを非表示 */
  hideAllActivities: () => void;

  /**
   * アクティビティ一覧と filter state を同期する。
   *
   * - 初回: 全アクティビティを表示 + `initialized=true`
   * - 2 回目以降: 既存の visible / hidden toggle を保持しつつ、
   *   新規は visible として追加、削除済み（orphan ID）は除去
   */
  syncWithActivities: (activityIds: string[]) => void;

  /** 特定のアクティビティを除去（統合後などに使用） */
  removeActivity: (activityId: string) => void;

  /** このアクティビティだけ表示（他を全てOFF） */
  showOnlyActivity: (activityId: string) => void;

  /** このカテゴリーのアクティビティだけ表示（context menu「このカテゴリーだけ表示」） */
  showOnlyCategoryActivities: (activityIds: string[]) => void;

  /** アクティビティが表示中かチェック */
  isActivityVisible: (activityId: string) => boolean;

  /** カテゴリー内アクティビティの表示状態を取得（all: 全ON, none: 全OFF, some: 一部） */
  getCategoryVisibility: (activityIds: string[]) => 'all' | 'none' | 'some';

  /** アクティビティフィルタに一致するかチェック（タイムブロックの表示判定もこれを使う） */
  matchesActivityFilter: (activityId: string | null) => boolean;
}

type CalendarFilterStore = CalendarFilterState & CalendarFilterActions;

// シリアライズ済みの状態型
interface SerializedCalendarFilterState {
  visibleActivityIds: string[];
  initialized: boolean;
  knownActivityIds: string[];
}

/** 永続化データが読めない / 旧タグモデルの時に戻す初期状態 */
function createInitialFilterState(): CalendarFilterState {
  return {
    visibleActivityIds: new Set<string>(),
    initialized: false,
    knownActivityIds: new Set<string>(),
  };
}

// カスタムシリアライザー（Setの永続化対応）
const setSerializer = {
  serialize: (state: CalendarFilterState): SerializedCalendarFilterState => ({
    visibleActivityIds: Array.from(state.visibleActivityIds),
    initialized: state.initialized,
    knownActivityIds: Array.from(state.knownActivityIds),
  }),
  deserialize: (state: unknown): CalendarFilterState => {
    if (typeof state !== 'object' || state === null) {
      return createInitialFilterState();
    }

    const rawVisibleActivityIds = Reflect.get(state, 'visibleActivityIds');
    const rawInitialized = Reflect.get(state, 'initialized');
    const rawKnownActivityIds = Reflect.get(state, 'knownActivityIds');
    const visibleActivityIds = Array.isArray(rawVisibleActivityIds)
      ? rawVisibleActivityIds.filter((id): id is string => typeof id === 'string')
      : [];
    const knownActivityIds = Array.isArray(rawKnownActivityIds)
      ? rawKnownActivityIds.filter((id): id is string => typeof id === 'string')
      : visibleActivityIds;

    return {
      visibleActivityIds: new Set(visibleActivityIds),
      initialized: rawInitialized === true,
      knownActivityIds: new Set(knownActivityIds),
    };
  },
};

/**
 * v8 以前の永続化データは全て破棄して初期状態へ落とす。
 *
 * v8 は state 名だけをアクティビティ語彙へ変えた段階で、**中身はまだタグ ID** だった
 * （データ源が tags のままだったため）。v9 で実データが activities へ切り替わり、
 * ID の値空間が変わる。そのまま読むと全 ID が未知になり、初回 sync までの間
 * 「カレンダーに何も表示されない」状態でアプリが開く。ID を引き継がず捨てることで、
 * 次の `syncWithActivities` が「初回」として全アクティビティを表示状態にする。
 */
export function migrateCalendarFilterState(
  persistedState: unknown,
  version: number,
): CalendarFilterState {
  if (version < 9 || typeof persistedState !== 'object' || persistedState === null) {
    return createInitialFilterState();
  }

  const rawVisibleActivityIds = Reflect.get(persistedState, 'visibleActivityIds');
  const rawInitialized = Reflect.get(persistedState, 'initialized');
  const rawKnownActivityIds = Reflect.get(persistedState, 'knownActivityIds');
  const visibleActivityIds =
    rawVisibleActivityIds instanceof Set
      ? Array.from(rawVisibleActivityIds).filter((id): id is string => typeof id === 'string')
      : [];
  const knownActivityIds =
    rawKnownActivityIds instanceof Set
      ? Array.from(rawKnownActivityIds).filter((id): id is string => typeof id === 'string')
      : visibleActivityIds;

  return {
    visibleActivityIds: new Set(visibleActivityIds),
    initialized: rawInitialized === true,
    knownActivityIds: new Set(knownActivityIds),
  };
}

/** カレンダーのアクティビティ表示フィルターを管理するZustandストア（localStorageに永続化） */
export const useCalendarFilterStore = create<CalendarFilterStore>()(
  devtools(
    persist<CalendarFilterStore, [], [], CalendarFilterState>(
      (set, get) => ({
        // 初期状態
        ...createInitialFilterState(),

        // アクション

        toggleActivity: (activityId) =>
          set((state) => {
            const newSet = new Set(state.visibleActivityIds);
            if (newSet.has(activityId)) {
              newSet.delete(activityId);
            } else {
              newSet.add(activityId);
            }
            return { visibleActivityIds: newSet };
          }),

        showAllActivities: (activityIds) =>
          set(() => ({
            visibleActivityIds: new Set(activityIds),
          })),

        hideAllActivities: () =>
          set(() => ({
            visibleActivityIds: new Set(),
          })),

        syncWithActivities: (activityIds) =>
          set((state) => {
            const activityIdSet = new Set(activityIds);

            if (!state.initialized) {
              // 初回は全アクティビティを表示
              return {
                visibleActivityIds: new Set(activityIds),
                knownActivityIds: activityIdSet,
                initialized: true,
              };
            }

            // 2 回目以降: 既存の visible / hidden toggle を保持しつつ
            //   - 新規（knownActivityIds に無い ID）は visible として追加
            //   - 削除済み（activityIdSet に無い visible ID）は orphan として除去
            //
            // 「新規」の判定は knownActivityIds（前回 sync 時点の全集合）で行う。
            // visibleActivityIds で判定すると、「このカテゴリーだけ表示」等で意図的に絞り込んだ
            // 直後の sync で「既存全部が新規」に見えて復活する（#1576フォローアップ）。
            const newSet = new Set<string>();
            for (const id of state.visibleActivityIds) {
              if (activityIdSet.has(id)) newSet.add(id);
            }
            for (const id of activityIds) {
              if (!state.knownActivityIds.has(id)) newSet.add(id);
            }
            return { visibleActivityIds: newSet, knownActivityIds: activityIdSet };
          }),

        removeActivity: (activityId) =>
          set((state) => {
            const newSet = new Set(state.visibleActivityIds);
            newSet.delete(activityId);
            return { visibleActivityIds: newSet };
          }),

        showOnlyActivity: (activityId) =>
          set(() => ({
            visibleActivityIds: new Set([activityId]),
          })),

        showOnlyCategoryActivities: (activityIds) =>
          set(() => ({
            visibleActivityIds: new Set(activityIds),
          })),

        isActivityVisible: (activityId) => get().visibleActivityIds.has(activityId),

        getCategoryVisibility: (activityIds) => {
          if (activityIds.length === 0) return 'none';
          const state = get();
          const visibleCount = activityIds.filter((id) => state.visibleActivityIds.has(id)).length;
          if (visibleCount === 0) return 'none';
          if (visibleCount === activityIds.length) return 'all';
          return 'some';
        },

        matchesActivityFilter: (activityId) => {
          // アクティビティ未設定のブロックは常に表示する。サイドバーに切替が無いので、
          // ここで false を返せるようにすると復帰手段のない非表示状態を作れてしまう
          if (activityId === null) return true;

          return get().visibleActivityIds.has(activityId);
        },
      }),
      {
        name: 'calendar-filter-storage',
        // バージョンを上げるとlocalStorageがリセットされる
        // v2: visibleTagIds競合問題の修正に伴いリセット
        // v3: showUntagged削除、matchesTagFilter/isPlanVisible単一タグ対応
        // v4: ItemType ('plan'|'record') → TimeblockOrigin ('planned'|'unplanned') に変更
        // v5: visibleTypes (origin filter) を削除 — unplanned origin 廃止
        // v6: showUntagged 復活。未分類(activity_id=null)ブロックのフィルター対応（#1576）
        // v7: knownTagIds 追加。syncWithTags が「新規タグ」と「意図的に非表示にした
        //     既知タグ」を区別するための基準集合（#1576フォローアップ）
        // v8: 状態名をアクティビティ語彙へ改名（visibleTagIds→visibleActivityIds /
        //     showUntagged→showNoActivity / knownTagIds→knownActivityIds）。
        //     ただしこの時点のデータ源はまだ tags で、中身はタグ ID だった
        // v9: データ源を activities へ切替。ID の値空間が変わるため migrate で全破棄する。
        //     あわせて showNoActivity を撤去（サイドバーの「アクティビティなし」行を
        //     置かない確定に伴い、未設定ブロックは常時表示になった）
        version: 9,
        storage: createPlatformStorage<CalendarFilterState>({
          serialize: setSerializer.serialize,
          deserialize: setSerializer.deserialize,
        }),
        partialize: ({ visibleActivityIds, initialized, knownActivityIds }) => ({
          visibleActivityIds,
          initialized,
          knownActivityIds,
        }),
        migrate: migrateCalendarFilterState,
      },
    ),
    { name: 'calendar-filter-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
