'use client';

/**
 * Inspector ドッキングパネル（PC用）
 *
 * DesktopLayout の3カラム目（lib/dom-slots 経由で登録される DOM ノード）へ
 * portal する非モーダルパネル。backdrop なし、Tab はカレンダー領域へ自由に抜けられる
 * （フォーカストラップは持たない）。開く前のフォーカス要素への復帰は維持する。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DockedInspectorPanelProps {
  children: ReactNode;
  title: string;
  slotElement: HTMLElement | null;
}

/** DesktopLayout の3カラム目へ portal するドッキング型 Inspector パネル */
export function DockedInspectorPanel({ children, title, slotElement }: DockedInspectorPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // 開く前のフォーカス要素を記録し（マウント時1回）、閉じたら復帰する。
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  // slotElement が用意でき次第フォーカスを移動する。DesktopLayout 側の ref 登録
  // （lib/dom-slots）が TimeblockInspector の初回レンダリングより後のコミットで
  // 揃うことがあるため、固定タイマーではなく slotElement の変化をトリガーにする
  // （behavior-verifier 指摘: 旧実装はマウント時1回の50ms固定タイマーで、slot登録が
  // 大幅に遅延するとフォーカスが黙って当たらないままになる余地があった）。
  useEffect(() => {
    if (!slotElement) return;
    const timer = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable ?? panel).focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [slotElement]);

  if (!slotElement) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="region"
      aria-label={title}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col gap-0 overflow-hidden focus:outline-none"
    >
      {/*
        overflow-x-hidden: 行の 44px タップ領域は擬似要素で外へ広げているため数 px はみ出す。
        overflow-y だけ指定すると CSS が横も auto に解決し、数 px の横スクロールが生まれる
        （2026-09-07 User 指摘）。見えない当たり判定なので横は落として構わない。
      */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
    </div>,
    slotElement,
  );
}
