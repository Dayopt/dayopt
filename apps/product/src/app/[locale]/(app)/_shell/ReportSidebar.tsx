import { ReportFilterList } from '@/features/review';

/**
 * Report タブの Sidebar 本体（Composition Layer、スクロール領域）。
 *
 * MiniCalendar は Sidebar の pinned 領域（プロフィール直上）へ移動済み（#2217）。
 * 中身は分析用のフィルタ 1 本だけ（カレンダーと同じ「カテゴリ」「未分類」の 2 見出し + 余白）。
 * セグメント一覧は 2026-09-15 に概念ごと撤去した（仕様 §2）。
 */
export function ReportSidebar() {
  return (
    // 外枠は `CalendarSidebar` と同じクラスにする。デスクトップのカレンダーは先頭の
    // `ViewSwitcherList` が md:hidden なので「カテゴリ」見出しが枠の最上端に来る。
    // ここだけ py-2 を持つと、タブを往復した時に見出しが 8px 下がって見える（2026-09-15 User 指摘）
    <div className="flex min-w-0 flex-col gap-2 overflow-hidden px-2">
      <ReportFilterList />
    </div>
  );
}
