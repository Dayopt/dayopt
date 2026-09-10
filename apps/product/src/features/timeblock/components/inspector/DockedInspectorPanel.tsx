'use client';

/**
 * Inspector ドッキングパネル（PC用）
 *
 * DesktopLayout の3カラム目（lib/dom-slots 経由で登録される DOM ノード）へ
 * portal する非モーダルパネル。backdrop なし、Tab はカレンダー領域へ自由に抜けられる
 * （フォーカストラップは持たない）。開く前のフォーカス要素への復帰は維持する。
 *
 * backdrop が無い代わりに、パネルの外を押したら閉じる（`onRequestClose`）。
 * モバイルの Drawer は overlay を押せば閉じるのに、PC だけ閉じる手段が × に限られ、
 * 開いたままだと他の操作へ進みづらかった（2026-09-07 User 指摘）。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * パネルの外にありながら「パネルの続き」として扱う層。
 *
 * popover / メニュー / dialog / トーストは document.body へ portal されるので、
 * DOM 上はパネルの外側になる。ここを押して閉じてしまうと、日付を選ぶ・メニューを
 * 開くといった操作そのものがパネルを畳んでしまう。
 *
 * `data-inspector-keep-open` は、パネルと組で動く画面上の部品が自分で付ける印。
 * 作成中の選択範囲（カレンダー上のハイライト）はこれを持ち、掴んで伸ばしても畳まれない。
 */
/**
 * カレンダー上のブロック。押しても閉じない。
 *
 * 開閉はカードの click ハンドラが決める（同じブロックなら閉じ、別のブロックなら
 * 中身を差し替える）。ここで pointerdown 時に閉じてしまうと、後から走る click が
 * 開き直すため、同じブロックを押しても閉じず、別のブロックへ移る時も一度畳まれて
 * から開く「またたき」になる（2026-09-10 User 指摘）。
 */
const TIMEBLOCK_CARD_SELECTOR = '[data-entry-block]';

const OVERLAY_LAYER_SELECTOR = [
  '[data-inspector-keep-open]',
  '[data-radix-popper-content-wrapper]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-sonner-toaster]',
  '[data-slot="drawer-portal"]',
].join(',');

interface DockedInspectorPanelProps {
  children: ReactNode;
  title: string;
  slotElement: HTMLElement | null;
  /** パネルの外を押した時に呼ぶ。省略すると外側クリックでは閉じない。 */
  onRequestClose?: (() => void) | undefined;
}

/** DesktopLayout の3カラム目へ portal するドッキング型 Inspector パネル */
export function DockedInspectorPanel({
  children,
  title,
  slotElement,
  onRequestClose,
}: DockedInspectorPanelProps) {
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

  // パネルの外を押したら閉じる。pointerdown を capture で見るのは、メニューなどが
  // 自分を閉じて DOM から外れる前に押した先を判定するため。
  useEffect(() => {
    if (!onRequestClose) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 押した瞬間に DOM から外れる要素（閉じたメニューの項目など）は判定できない
      if (!target.isConnected) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest(OVERLAY_LAYER_SELECTOR)) return;
      // ブロックの開閉はカード側の click に委ねる
      if (target.closest(TIMEBLOCK_CARD_SELECTOR)) return;
      onRequestClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onRequestClose]);

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
