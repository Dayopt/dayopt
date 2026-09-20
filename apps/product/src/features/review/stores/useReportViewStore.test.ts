import { beforeEach, describe, expect, it } from 'vitest';

import { resolveVisibleActivities } from '../domain/report/report-view-model';
import { migrateReportViewState, useReportViewStore } from './useReportViewStore';

const STORAGE_KEY = 'report-view-storage';

const ALL_VISIBLE = {
  hiddenCategoryIds: [],
  hiddenActivityIds: [],
};

function resetStore() {
  useReportViewStore.setState({ ...ALL_VISIBLE });
}

function filterOf() {
  const state = useReportViewStore.getState();
  return {
    hiddenCategoryIds: state.hiddenCategoryIds,
    hiddenActivityIds: state.hiddenActivityIds,
  };
}

describe('useReportViewStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  describe('既定値', () => {
    it('すべて可視で始まる', () => {
      const state = useReportViewStore.getState();

      expect(state.hiddenCategoryIds).toEqual([]);
      expect(state.hiddenActivityIds).toEqual([]);
    });
  });

  describe('toggleCategory', () => {
    it('隠す / 戻すを往復できる', () => {
      useReportViewStore.getState().toggleCategory('cat-sleep');
      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual(['cat-sleep']);

      useReportViewStore.getState().toggleCategory('cat-sleep');
      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual([]);
    });

    it('複数のカテゴリーを独立に隠せる', () => {
      useReportViewStore.getState().toggleCategory('cat-sleep');
      useReportViewStore.getState().toggleCategory('cat-work');

      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual(['cat-sleep', 'cat-work']);
    });

    /**
     * 未チェックの親を押す意図は「このカテゴリーを見る」。配下に個別に隠した子が残っていると、
     * チェックしたのに何も戻らない行ができる。
     */
    it('隠れているカテゴリーを戻す時は、渡された配下の hidden も解く', () => {
      useReportViewStore.getState().toggleActivity('act-nap');
      useReportViewStore.getState().toggleActivity('act-walk');
      useReportViewStore.getState().toggleCategory('cat-sleep');

      useReportViewStore.getState().toggleCategory('cat-sleep', ['act-nap']);

      expect(useReportViewStore.getState().hiddenCategoryIds).toEqual([]);
      // 別カテゴリーの子には触らない
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-walk']);
    });

    it('隠す方向では配下の hidden に触らない', () => {
      useReportViewStore.getState().toggleActivity('act-nap');

      useReportViewStore.getState().toggleCategory('cat-sleep', ['act-nap']);

      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-nap']);
    });

    /**
     * hidden 方式であることの本体。`useCalendarFilterStore` の `knownActivityIds` に当たる
     * 同期機構を持たなくても、後から増えたカテゴリーが分母に入る（受け入れ条件 3）。
     */
    it('store が知らないカテゴリーは可視のまま扱われる', () => {
      useReportViewStore.getState().toggleCategory('cat-sleep');

      const visible = resolveVisibleActivities(
        [
          { ...activityAggregate('act-nap'), categoryId: 'cat-sleep' },
          // store が一度も見たことのない、あとから作られたカテゴリー
          { ...activityAggregate('act-walk'), categoryId: 'cat-brand-new' },
        ],
        filterOf(),
      );

      expect(visible.map((activity) => activity.activityId)).toEqual(['act-walk']);
    });
  });

  describe('toggleActivity', () => {
    it('隠す / 戻すを往復でき、同じカテゴリーの他の行は残る', () => {
      useReportViewStore.getState().toggleActivity('act-nap');
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-nap']);

      const visible = resolveVisibleActivities(
        [
          { ...activityAggregate('act-nap'), categoryId: 'cat-sleep' },
          { ...activityAggregate('act-rest'), categoryId: 'cat-sleep' },
        ],
        filterOf(),
      );
      expect(visible.map((activity) => activity.activityId)).toEqual(['act-rest']);

      useReportViewStore.getState().toggleActivity('act-nap');
      expect(useReportViewStore.getState().hiddenActivityIds).toEqual([]);
    });
  });

  describe('永続化', () => {
    it('state だけを保存し、action は保存しない', () => {
      useReportViewStore.getState().toggleCategory('cat-sleep');
      useReportViewStore.getState().toggleActivity('act-dev');

      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
        state: {
          hiddenCategoryIds: ['cat-sleep'],
          hiddenActivityIds: ['act-dev'],
        },
        version: 2,
      });
    });

    /**
     * 純粋関数の test だけでは storage → deserialize → migrate の配線ミスを捕まえられない。
     * 実際の persist middleware を通す。
     */
    it('localStorage から実際に復元する', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            hiddenCategoryIds: ['cat-work'],
            hiddenActivityIds: ['act-dev'],
          },
          version: 2,
        }),
      );

      await useReportViewStore.persist.rehydrate();

      const state = useReportViewStore.getState();
      expect(state.hiddenCategoryIds).toEqual(['cat-work']);
      expect(state.hiddenActivityIds).toEqual(['act-dev']);
    });

    /**
     * v1（セグメント選択・未分類の一括フラグ・余白の切替付き）の localStorage を v2 へ持ち上げる。
     * カテゴリーは引き継ぎ、v2 に無い 3 つは捨てる（未分類は全部見える状態へ戻る）。
     */
    it('v1 の保存値からセグメント選択と未分類フラグを捨ててフィルタを引き継ぐ', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            hiddenCategoryIds: ['cat-work'],
            uncategorizedHidden: true,
            marginHidden: true,
            segmentId: 'seg-1',
          },
          version: 1,
        }),
      );

      await useReportViewStore.persist.rehydrate();

      const state = useReportViewStore.getState();
      expect(state.hiddenCategoryIds).toEqual(['cat-work']);
      expect(state.hiddenActivityIds).toEqual([]);
      expect('segmentId' in state).toBe(false);
      expect('uncategorizedHidden' in state).toBe(false);
      expect('marginHidden' in state).toBe(false);
    });

    /**
     * zustand は保存された version が現在と一致していると `migrate` を呼ばない。
     * サニタイズを `merge` にも掛けていないと、壊れた値がそのまま state へ入り、
     * `hiddenCategoryIds.includes()` でサイドバーが落ちる。
     */
    it('version が一致していても壊れた値をサニタイズする', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            hiddenCategoryIds: 'cat-work',
            hiddenActivityIds: { bad: true },
          },
          version: 2,
        }),
      );

      await useReportViewStore.persist.rehydrate();

      const state = useReportViewStore.getState();
      expect(state.hiddenCategoryIds).toEqual([]);
      expect(state.hiddenActivityIds).toEqual([]);
      // action は失われない（merge で currentState を土台にしている）
      expect(typeof state.toggleCategory).toBe('function');
    });
  });

  describe('migrateReportViewState', () => {
    it('正しい形はそのまま通す', () => {
      expect(
        migrateReportViewState(
          {
            hiddenCategoryIds: ['cat-work'],
            hiddenActivityIds: ['act-dev'],
          },
          2,
        ),
      ).toEqual({
        hiddenCategoryIds: ['cat-work'],
        hiddenActivityIds: ['act-dev'],
      });
    });

    it('object でない payload は既定へ倒す', () => {
      expect(migrateReportViewState('壊れた', 2)).toEqual(ALL_VISIBLE);
    });

    it('型の違う値を捨てて既定へ倒す', () => {
      expect(
        migrateReportViewState(
          {
            hiddenCategoryIds: 'cat-work',
            hiddenActivityIds: 42,
          },
          2,
        ),
      ).toEqual(ALL_VISIBLE);
    });

    it('配列の中の非文字列だけを落とす', () => {
      expect(
        migrateReportViewState(
          {
            hiddenCategoryIds: ['cat-work', 7, null, 'cat-sleep'],
            hiddenActivityIds: [null, 'act-dev'],
          },
          2,
        ),
      ).toEqual({
        hiddenCategoryIds: ['cat-work', 'cat-sleep'],
        hiddenActivityIds: ['act-dev'],
      });
    });
  });
});

/** `resolveVisibleActivities` へ渡す最小の集計行。 */
function activityAggregate(activityId: string) {
  return {
    activityId,
    activityName: activityId,
    categoryId: null as string | null,
    categoryName: null,
    categoryColor: null,
    categoryIcon: null,
    archived: false,
    recordedMinutes: 60,
    plannedMinutes: 0,
    plannedPastMinutes: 0,
    plannedPastBoxes: 0,
    recordBoxes: 1,
    durationCounts: [] as [number, number][],
    byHour: [] as number[],
    fulfillment: { low: 0, medium: 0, high: 0 },
    byBucket: [],
  };
}
