/**
 * Keyboard Shortcut Registry
 *
 * app全体のキーボードショートカットを一元管理するレジストリ。
 * - 開発時のコンフリクト検出
 * - 単一のグローバルkeydownリスナーによる処理
 *
 * 「何が存在するか」の宣言は shortcut-catalog.ts が持つ。ここはキーとハンドラの
 * 結び付けだけを持つ。
 */

import { logger } from '@/lib/logger';

import { hasOpenKeyboardOverlay } from './keyboard-overlay';

// =============================================================================
// Types
// =============================================================================

/** ショートカット定義 */
export interface ShortcutDef {
  /** 正規化されたキーコンボ（例: 'D', 'Cmd+W', 'Delete', 'Shift+C'） */
  key: string;
  /** キーイベントハンドラ */
  handler: (event: KeyboardEvent) => void;
  /** 説明（デバッグ用） */
  description: string;
  /** 優先度（高い方が優先。デフォルト: 0） */
  priority?: number;
}

interface RegisteredShortcut {
  def: ShortcutDef;
  id: symbol;
}

// =============================================================================
// Registry (module-level singleton)
// =============================================================================

const registry = new Map<string, RegisteredShortcut[]>();

const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * キーコンボを正規化する
 * イベントのキー情報から「Cmd+Shift+C」のような正規化文字列を生成
 */
function normalizeKeyCombo(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.metaKey || event.ctrlKey) {
    parts.push('Cmd');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (event.altKey) {
    parts.push('Alt');
  }

  // キーの正規化
  let key = event.key;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Delete':
    case 'Backspace':
    case 'Escape':
    case 'Enter':
    case 'Tab':
      // 特殊キーはそのまま
      break;
    default:
      // 英字は大文字化、数字はそのまま
      if (key.length === 1) {
        key = key.toUpperCase();
      }
  }

  parts.push(key);
  return parts.join('+');
}

/**
 * ショートカットを登録する
 *
 * @returns unregister関数
 */
export function registerShortcut(def: ShortcutDef): () => void {
  const id = Symbol(def.description);
  const entry: RegisteredShortcut = { def, id };

  const existing = registry.get(def.key);
  if (existing) {
    // 開発時: コンフリクト警告
    if (isDevelopment) {
      const descriptions = existing.map((e) => e.def.description);
      logger.warn(
        `[ShortcutRegistry] "${def.key}" に複数ハンドラ登録: [${descriptions.join(', ')}] ← "${def.description}"`,
      );
    }
    existing.push(entry);
    // 優先度降順でソート
    existing.sort((a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0));
  } else {
    registry.set(def.key, [entry]);
  }

  // unregister
  return () => {
    const entries = registry.get(def.key);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      entries.splice(idx, 1);
    }
    if (entries.length === 0) {
      registry.delete(def.key);
    }
  };
}

/**
 * 複数のショートカットを一括登録する
 *
 * @returns 全ショートカットを一括解除する関数
 */
export function registerShortcuts(defs: ShortcutDef[]): () => void {
  const unregisterFns = defs.map((def) => registerShortcut(def));
  return () => {
    for (const unregister of unregisterFns) {
      unregister();
    }
  };
}

const EDITABLE_SELECTOR = 'input, textarea, select, [role="textbox"], [role="combobox"]';
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

/** グローバルショートカットを受け取った要素を解決する。 */
function getEventElement(event: KeyboardEvent): Element | null {
  if (event.target instanceof Element) return event.target;
  return document.activeElement instanceof Element ? document.activeElement : null;
}

/** 入力・選択操作を行う要素かどうかを判定する。 */
function isEditableElement(element: Element): boolean {
  if (element.closest(EDITABLE_SELECTOR)) return true;

  const contentEditable = element.closest('[contenteditable]');
  return contentEditable !== null && contentEditable.getAttribute('contenteditable') !== 'false';
}

/** dialog/menu/listbox が所有するキー操作かどうかを判定する。 */
function isInsideOverlay(element: Element): boolean {
  return element.closest(OVERLAY_SELECTOR) !== null;
}

/**
 * グローバルkeydownイベントを処理する
 *
 * レジストリに登録されたショートカットを照合し、最も優先度の高いハンドラを実行する。
 * 入力フィールドやoverlay内のキー操作、および既に処理済みのイベントはスキップする。
 * ただし子オーバーレイがない場合の未処理 Escape は Inspector などの global close へ渡す。
 */
export function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape' && hasOpenKeyboardOverlay()) return;

  const combo = normalizeKeyCombo(event);
  const eventElement = getEventElement(event);
  if (
    combo !== 'Escape' &&
    eventElement &&
    (isEditableElement(eventElement) || isInsideOverlay(eventElement))
  ) {
    return;
  }

  const entries = registry.get(combo);
  if (!entries || entries.length === 0) return;

  // 優先度が最も高いハンドラを実行（既にソート済み）
  const topEntry = entries[0];
  if (topEntry) {
    topEntry.def.handler(event);
  }
}
