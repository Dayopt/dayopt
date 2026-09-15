/**
 * `/report` の表示状態（フィルタ）。
 *
 * **端末ローカルにだけ持つ**（仕様 §2）。アカウント同期しないので、別ブラウザ・別端末には
 * 持ち越さない。分母の出し入れは「今この画面をどう読むか」であって、アカウントの設定ではない。
 *
 * **hidden を持つ**（visible ではない）。ここに載っていないカテゴリー / アクティビティは可視なので、
 * 新しく作ったものは自動で分母に入る。`useCalendarFilterStore` が必要としている
 * `knownActivityIds`（「新規」と「意図的に隠した既知」を見分けるための第 3 の集合）は、
 * この形では要らない。消えた ID が hidden に残っても、一致する行が無いだけで無害。
 *
 * カテゴリーとアクティビティの hidden は独立した 2 集合で持つ。カテゴリーを隠すと配下は
 * まとめて出ず（アーカイブ済みで一覧に無いアクティビティも含めて）、アクティビティを隠すと
 * その 1 行だけが出ない。
 *
 * v1 が持っていたセグメントのレンズ（`segmentId`）は 2026-09-15 に概念ごと撤去した。
 * アクティビティ単位のフィルタが入れば「この数個だけで見る」は他を外すことで足り、
 * 別概念を持つ理由が無くなったため。
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { platformStorage } from '@/lib/zustand/storage';

import { defaultReportFilterState } from '../domain/report/report-view-model';

interface ReportViewState {
  /** ここに無いカテゴリーは可視。新しく作ったカテゴリーは自動で可視になる。 */
  hiddenCategoryIds: string[];
  /** ここに無いアクティビティは可視。新しく作ったアクティビティは自動で可視になる。 */
  hiddenActivityIds: string[];
}

interface ReportViewActions {
  /**
   * カテゴリーの出し入れ。
   *
   * 隠れているカテゴリーを戻す時は、`memberActivityIds` に載った配下の hidden も
   * まとめて解く。外したカテゴリーを戻す意図は「このカテゴリーを見る」なので、一部の子だけ
   * 隠れたままの状態（戻したのに何も出ない）を作らない。
   */
  toggleCategory: (categoryId: string, memberActivityIds?: readonly string[]) => void;
  toggleActivity: (activityId: string) => void;
}

type ReportViewStore = ReportViewState & ReportViewActions;

/** 既定は「すべて可視」。派生側の既定と 1 箇所で揃える。 */
function createInitialReportViewState(): ReportViewState {
  return {
    hiddenCategoryIds: [...defaultReportFilterState.hiddenCategoryIds],
    hiddenActivityIds: [...defaultReportFilterState.hiddenActivityIds],
  };
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : fallback;
}

function withoutIds(ids: readonly string[], remove: readonly string[]): string[] {
  const removeSet = new Set(remove);
  return ids.filter((id) => !removeSet.has(id));
}

/**
 * 永続化された state を現在の形へ寄せる。
 *
 * localStorage は他バージョンの Dayopt・拡張・手編集で壊れうるため、型が違う値は既定へ倒す。
 * `persist` の中へ書かず独立 export しているのは、そのまま unit test にかけるため。
 *
 * **`migrate` だけでなく `merge` にも渡す。** zustand の persist が `migrate` を呼ぶのは
 * 保存された version が現在と**違う**時だけ（zustand 5.0.14 `middleware.mjs`）。version が
 * 一致したまま中身が壊れている localStorage はサニタイズを素通りし、`hiddenCategoryIds` が
 * 配列でなければ `.includes()` でサイドバーごと落ちる。`merge` は毎回のハイドレーションで
 * 必ず呼ばれるので、こちらを実際の防波堤にする。
 *
 * version に依存しない形にしてある。`merge` が受け取るのは `migrate` 済みの state なので、
 * ここが版数で分岐すると、将来 v3 を書いた瞬間に v3 の state へ旧版の変換を再適用してしまう。
 * 版ごとの移行は `migrateReportViewState` 側に書く。
 */
function sanitizeReportViewState(persistedState: unknown): ReportViewState {
  const defaults = createInitialReportViewState();
  if (typeof persistedState !== 'object' || persistedState === null) return defaults;

  return {
    hiddenCategoryIds: toStringArray(
      Reflect.get(persistedState, 'hiddenCategoryIds'),
      defaults.hiddenCategoryIds,
    ),
    hiddenActivityIds: toStringArray(
      Reflect.get(persistedState, 'hiddenActivityIds'),
      defaults.hiddenActivityIds,
    ),
  };
}

/**
 * 版をまたぐ移行。
 *
 * v1 → v2: `segmentId` / `uncategorizedHidden` / `marginHidden` を捨て、`hiddenActivityIds` を
 * 空で足す。サニタイズは知らないキーを拾わず、無いキーを既定で埋めるので、形の変換そのものは
 * サニタイズと同義。未分類はカレンダーと同じくアクティビティ単位でだけ出し入れするので、
 * v1 で未分類をまとめて隠していた端末は「全部見える」へ戻る（可逆で、1 手で隠し直せる）。
 * 余白の切替は概念ごと撤去した（余白は常に分母に入る）。
 */
export function migrateReportViewState(persistedState: unknown, _version: number): ReportViewState {
  return sanitizeReportViewState(persistedState);
}

/** `/report` のフィルタを持つ Zustand ストア（localStorage 永続化）。 */
export const useReportViewStore = create<ReportViewStore>()(
  devtools(
    persist<ReportViewStore, [], [], ReportViewState>(
      (set) => ({
        ...createInitialReportViewState(),

        toggleCategory: (categoryId, memberActivityIds = []) =>
          set((state) =>
            state.hiddenCategoryIds.includes(categoryId)
              ? {
                  hiddenCategoryIds: state.hiddenCategoryIds.filter((id) => id !== categoryId),
                  hiddenActivityIds: withoutIds(state.hiddenActivityIds, memberActivityIds),
                }
              : { hiddenCategoryIds: [...state.hiddenCategoryIds, categoryId] },
          ),

        toggleActivity: (activityId) =>
          set((state) => ({
            hiddenActivityIds: state.hiddenActivityIds.includes(activityId)
              ? state.hiddenActivityIds.filter((id) => id !== activityId)
              : [...state.hiddenActivityIds, activityId],
          })),
      }),
      {
        name: 'report-view-storage',
        version: 2,
        storage: platformStorage<ReportViewState>(),
        partialize: ({ hiddenCategoryIds, hiddenActivityIds }) => ({
          hiddenCategoryIds,
          hiddenActivityIds,
        }),
        migrate: migrateReportViewState,
        // version が一致していてもここは通る。壊れた値を state へ入れない最後の関門。
        // hydrate は replace 呼び出しなので `...currentState` で action を保つ
        merge: (persistedState, currentState) => ({
          ...currentState,
          ...sanitizeReportViewState(persistedState),
        }),
      },
    ),
    { name: 'report-view-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
