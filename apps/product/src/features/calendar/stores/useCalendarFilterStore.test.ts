import { beforeEach, describe, expect, it } from 'vitest';

import { migrateCalendarFilterState, useCalendarFilterStore } from './useCalendarFilterStore';

describe('useCalendarFilterStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useCalendarFilterStore.setState({
      visibleActivityIds: new Set<string>(),
      initialized: false,
      knownActivityIds: new Set<string>(),
    });
  });

  describe('初期状態', () => {
    it('未初期化状態', () => {
      expect(useCalendarFilterStore.getState().initialized).toBe(false);
    });
  });

  describe('永続化', () => {
    it('Setを配列へ変換し、stateだけを保存する', () => {
      useCalendarFilterStore.getState().showAllActivities(['activity-1', 'activity-2']);
      useCalendarFilterStore.setState({ initialized: true });

      expect(JSON.parse(localStorage.getItem('calendar-filter-storage') ?? '')).toEqual({
        state: {
          visibleActivityIds: ['activity-1', 'activity-2'],
          initialized: true,
          knownActivityIds: [],
        },
        version: 9,
      });
    });

    // v9 でデータ源が tags から activities へ切り替わり、ID の値空間が変わる。
    // v8 は state 名だけを改名した段階で中身はまだタグ ID だったため、v8 も含めて
    // 引き継がない。引き継ぐと全 ID が未知になり「カレンダーに何も表示されない」
    // 状態でアプリが開く。v8 以前は中身によらず初期状態へ落とすのが契約。
    it.each([4, 5, 6, 7, 8])(
      'v%i（タグ ID を持つ世代）の永続化データは初期状態へ落とす',
      (version) => {
        expect(
          migrateCalendarFilterState(
            {
              visibleTagIds: new Set(['tag-1', 'tag-2']),
              initialized: true,
              showUntagged: false,
              knownTagIds: new Set(['tag-1', 'tag-2']),
            },
            version,
          ),
        ).toEqual({
          visibleActivityIds: new Set<string>(),
          initialized: false,
          knownActivityIds: new Set<string>(),
        });
      },
    );

    it('v8 から移行した直後の sync は「初回」として全アクティビティを表示する', () => {
      const migrated = migrateCalendarFilterState(
        {
          visibleActivityIds: new Set(['tag-1']),
          initialized: true,
          knownActivityIds: new Set(['tag-1']),
        },
        8,
      );
      useCalendarFilterStore.setState(migrated);

      // initialized=false に落ちているので syncWithActivities が初回扱いになり、
      // 新モデルの ID が全て visible になる（旧タグ ID は残らない）
      useCalendarFilterStore.getState().syncWithActivities(['activity-1', 'activity-2']);
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds).toEqual(new Set(['activity-1', 'activity-2']));
      expect(state.visibleActivityIds.has('tag-1')).toBe(false);
    });

    it('v9 の永続化データはそのまま保持する', () => {
      expect(
        migrateCalendarFilterState(
          {
            visibleActivityIds: new Set(['activity-1']),
            initialized: true,
            knownActivityIds: new Set(['activity-1', 'activity-2']),
          },
          9,
        ),
      ).toEqual({
        visibleActivityIds: new Set(['activity-1']),
        initialized: true,
        knownActivityIds: new Set(['activity-1', 'activity-2']),
      });
    });

    it('v9 で knownActivityIds が無ければ visibleActivityIds をフォールバックに使う', () => {
      expect(
        migrateCalendarFilterState(
          { visibleActivityIds: new Set(['activity-1']), initialized: true },
          9,
        ),
      ).toEqual({
        visibleActivityIds: new Set(['activity-1']),
        initialized: true,
        // knownActivityIds が無ければ visibleActivityIds をフォールバックに使う
        knownActivityIds: new Set(['activity-1']),
      });
    });
  });

  // #2188: 上記の migrate 系 test は migrateCalendarFilterState を直接呼ぶだけで、
  // 実際の永続化パイプライン（localStorage → persist middleware の deserialize → migrate）
  // は経由しない。ここでは旧バージョンの生 payload を localStorage に置いた状態から
  // `persist.rehydrate()` で実ラウンドトリップさせ、migrate まで含めた結線を検証する。
  describe('localStorage 実ラウンドトリップ', () => {
    const STORAGE_KEY = 'calendar-filter-storage';

    it('v8 の永続化データを localStorage に置いて rehydrate すると、migrate により初期状態へ落ちる', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            visibleActivityIds: ['tag-1', 'tag-2'],
            initialized: true,
            knownActivityIds: ['tag-1', 'tag-2'],
          },
          version: 8,
        }),
      );

      await useCalendarFilterStore.persist.rehydrate();

      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds).toEqual(new Set<string>());
      expect(state.initialized).toBe(false);
      expect(state.knownActivityIds).toEqual(new Set<string>());
    });

    it('v9 の永続化データを localStorage に置いて rehydrate すると、そのまま復元される', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            visibleActivityIds: ['activity-1'],
            initialized: true,
            knownActivityIds: ['activity-1', 'activity-2'],
          },
          version: 9,
        }),
      );

      await useCalendarFilterStore.persist.rehydrate();

      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds).toEqual(new Set(['activity-1']));
      expect(state.initialized).toBe(true);
      expect(state.knownActivityIds).toEqual(new Set(['activity-1', 'activity-2']));
    });

    it('永続化データが無ければ rehydrate しても初期状態のまま', async () => {
      await useCalendarFilterStore.persist.rehydrate();

      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds).toEqual(new Set<string>());
      expect(state.initialized).toBe(false);
      expect(state.knownActivityIds).toEqual(new Set<string>());
    });
  });

  describe('toggleActivity', () => {
    it('アクティビティを追加できる', () => {
      useCalendarFilterStore.getState().toggleActivity('tag-1');
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-1')).toBe(true);
    });

    it('既存アクティビティを削除できる', () => {
      useCalendarFilterStore.getState().toggleActivity('tag-1');
      useCalendarFilterStore.getState().toggleActivity('tag-1');
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-1')).toBe(false);
    });
  });

  describe('showAllActivities / hideAllActivities', () => {
    it('全アクティビティを表示できる', () => {
      const activityIds = ['activity-1', 'activity-2', 'activity-3'];
      useCalendarFilterStore.getState().showAllActivities(activityIds);
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds.size).toBe(3);
    });

    it('全アクティビティを非表示にできる', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().hideAllActivities();
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds.size).toBe(0);
    });

    it('2回目は既存 visible を保持しつつ新規を visible として追加', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2', 'tag-3']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(true);
      expect(ids.has('tag-2')).toBe(true);
      expect(ids.has('tag-3')).toBe(true);
    });

    it('削除済み（orphan ID）は除去される', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2', 'tag-3']);
      // tag-3 が削除された想定で再 sync
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(true);
      expect(ids.has('tag-2')).toBe(true);
      expect(ids.has('tag-3')).toBe(false);
    });

    it('一時 ID → 実 ID の置き換えで orphan が cleanup される', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1']);
      // 楽観更新で temp-2 を追加
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'temp-2']);
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('temp-2')).toBe(true);
      // mutation 成功で temp-2 → real-2 に置き換わる
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'real-2']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(true);
      expect(ids.has('real-2')).toBe(true);
      expect(ids.has('temp-2')).toBe(false);
    });

    it('アーカイブ済みの ID を含めれば visibleActivityIds から消えない（#1576 P1回帰）', () => {
      // 初回: tag-1（通常）と tag-archived（後にアーカイブされる想定）を表示
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-archived']);
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-archived')).toBe(true);

      // tag-archived をアーカイブした後も、呼び出し元がアーカイブ済み ID を含めて
      // syncWithActivities を呼べば orphan 扱いされず visible のまま残る。
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-archived']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(true);
      expect(ids.has('tag-archived')).toBe(true);
    });

    it('アーカイブ済み ID を含めずに sync すると orphan として除去される（regressionの再現）', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-archived']);
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-archived')).toBe(true);

      // tags.list（アクティブのみ）由来の ID だけで sync すると、
      // アーカイブ済みタグは orphan として消えてしまう。これが #1576 で起きたバグ。
      useCalendarFilterStore.getState().syncWithActivities(['tag-1']);
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-archived')).toBe(false);
    });

    it('全部を隠した後に syncWithActivities が走っても復活しない（#1576フォローアップ）', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().hideAllActivities();
      expect(useCalendarFilterStore.getState().visibleActivityIds.size).toBe(0);

      // 一覧に変化が無くても、アーカイブ/復元/削除/作成のいずれかで syncWithActivities は
      // 再実行される。visibleActivityIds が空のままであるべき。
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds.size).toBe(0);
    });

    it('全部を隠した後でも新規は syncWithActivities で表示される（#1576フォローアップ）', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().hideAllActivities();
      expect(useCalendarFilterStore.getState().visibleActivityIds.size).toBe(0);

      // tag-3 は knownActivityIds に無い「本当に新規」なので visible として追加される。
      // tag-1 / tag-2 は意図的に隠した既知の ID なので復活しない。
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2', 'tag-3']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(false);
      expect(ids.has('tag-2')).toBe(false);
      expect(ids.has('tag-3')).toBe(true);
    });

    it('個別に非表示にしたアクティビティも syncWithActivities で復活しない', () => {
      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().toggleActivity('tag-1'); // tag-1 だけ非表示
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-1')).toBe(false);

      useCalendarFilterStore.getState().syncWithActivities(['tag-1', 'tag-2']);
      const ids = useCalendarFilterStore.getState().visibleActivityIds;
      expect(ids.has('tag-1')).toBe(false);
      expect(ids.has('tag-2')).toBe(true);
    });
  });

  describe('removeActivity', () => {
    it('アクティビティを除去できる', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1', 'tag-2']);
      useCalendarFilterStore.getState().removeActivity('tag-1');
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-1')).toBe(false);
      expect(useCalendarFilterStore.getState().visibleActivityIds.has('tag-2')).toBe(true);
    });
  });

  describe('showOnly系', () => {
    it('showOnlyActivity: 指定アクティビティのみ表示', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1', 'tag-2', 'tag-3']);
      useCalendarFilterStore.getState().showOnlyActivity('tag-2');
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds.size).toBe(1);
      expect(state.visibleActivityIds.has('tag-2')).toBe(true);
    });

    it('showOnlyCategoryActivities: 指定カテゴリーのアクティビティのみ表示', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1', 'tag-2', 'tag-3']);
      useCalendarFilterStore.getState().showOnlyCategoryActivities(['tag-1', 'tag-3']);
      const state = useCalendarFilterStore.getState();
      expect(state.visibleActivityIds.size).toBe(2);
    });
  });

  describe('アクティビティ未設定ブロックの表示', () => {
    // サイドバーに「アクティビティなし」のフィルタ行を置かない確定（2026-08-18 User 指示）に
    // 伴い、未設定ブロックは常に表示する。state を持たせると UI から戻せない非表示状態を
    // 作れてしまうため、state ごと撤去した。この契約をここで凍結する。
    it('matchesActivityFilter(null) は常に true', () => {
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
      useCalendarFilterStore.getState().hideAllActivities();
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
    });

    it('matchesActivityFilter(null) は常に true', () => {
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
      useCalendarFilterStore.getState().showOnlyActivity('tag-1');
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
    });
  });

  describe('クエリ系', () => {
    it('isActivityVisible', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1']);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-1')).toBe(true);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-99')).toBe(false);
    });

    it('getCategoryVisibility: all / none / some', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1', 'tag-2']);
      expect(useCalendarFilterStore.getState().getCategoryVisibility(['tag-1', 'tag-2'])).toBe(
        'all',
      );

      useCalendarFilterStore.getState().toggleActivity('tag-1');
      expect(useCalendarFilterStore.getState().getCategoryVisibility(['tag-1', 'tag-2'])).toBe(
        'some',
      );

      useCalendarFilterStore.getState().hideAllActivities();
      expect(useCalendarFilterStore.getState().getCategoryVisibility(['tag-1', 'tag-2'])).toBe(
        'none',
      );
    });

    it('getCategoryVisibility: 空配列はnone', () => {
      expect(useCalendarFilterStore.getState().getCategoryVisibility([])).toBe('none');
    });

    it('matchesActivityFilter: アクティビティ未設定ブロックは常に表示される', () => {
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
    });

    it('matchesActivityFilter: アクティビティ付きアイテム', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1']);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-1')).toBe(true);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-99')).toBe(false);
    });

    it('matchesActivityFilter: アクティビティフィルターのチェック', () => {
      useCalendarFilterStore.getState().showAllActivities(['tag-1']);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-1')).toBe(true);
      expect(useCalendarFilterStore.getState().matchesActivityFilter('tag-99')).toBe(false);
      expect(useCalendarFilterStore.getState().matchesActivityFilter(null)).toBe(true);
    });
  });
});
