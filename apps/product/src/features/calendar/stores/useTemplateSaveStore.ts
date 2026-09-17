import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * 「この並びをテンプレートとして保存」の保存モード。
 *
 * 以前は CalendarController のローカル state だったが、サイドバーのテンプレート
 * 見出しの「+」からも起動する（2026-09-14 UI レビュー。空状態の文言から作り方へ
 * 辿り着けなかった）ため、shell と calendar の両方が読める store にする。
 *
 * 値は「保存対象の日（yyyy-MM-dd）」。実際に保存ヘッダーを出すかは
 * CalendarController が「今見えている日と一致し、日ビューである」ことから導出する
 * （日を動かしたら自然に閉じる、という既存の関係を保つ）。
 */
interface TemplateSaveState {
  savingDateKey: string | null;
  /** 指定した日の並びをテンプレートとして保存するモードへ入る */
  startSaving: (dateKey: string) => void;
  stopSaving: () => void;
}

export const useTemplateSaveStore = create<TemplateSaveState>()(
  devtools(
    (set) => ({
      savingDateKey: null,
      startSaving: (dateKey) => set({ savingDateKey: dateKey }),
      stopSaving: () => set({ savingDateKey: null }),
    }),
    { name: 'template-save-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
