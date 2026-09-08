import { useEffect } from 'react';

import { hasOpenKeyboardOverlay } from '@/lib/keyboard/keyboard-overlay';

interface UseInspectorKeyboardOptions {
  /** Inspectorが開いているか */
  isOpen: boolean;
  /** 前のアイテムが存在するか */
  hasPrevious?: boolean;
  /** 次のアイテムが存在するか */
  hasNext?: boolean;
  /** 閉じるハンドラー */
  onClose: () => void;
  /** 前へ移動ハンドラー */
  onPrevious?: () => void;
  /** 次へ移動ハンドラー */
  onNext?: () => void;
}

/**
 * Inspector用キーボードショートカット
 *
 * - Escape: 閉じる
 * - ArrowUp / k: 前へ
 * - ArrowDown / j: 次へ
 *
 * 入力中（contentEditable, input, textarea）は無視
 *
 * @example
 * ```tsx
 * useInspectorKeyboard({
 *   isOpen,
 *   hasPrevious,
 *   hasNext,
 *   onClose: closeInspector,
 *   onPrevious: goToPrevious,
 *   onNext: goToNext,
 * })
 * ```
 */
export function useInspectorKeyboard({
  isOpen,
  hasPrevious = false,
  hasNext = false,
  onClose,
  onPrevious,
  onNext,
}: UseInspectorKeyboardOptions): void {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || hasOpenKeyboardOverlay()) return;
      // 入力中は無視
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        // Escapeのみ入力中でも有効
        if (e.key === 'Escape') {
          onClose();
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowUp':
        case 'k':
          if (hasPrevious && onPrevious) {
            e.preventDefault();
            onPrevious();
          }
          break;
        case 'ArrowDown':
        case 'j':
          if (hasNext && onNext) {
            e.preventDefault();
            onNext();
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, hasPrevious, hasNext, onClose, onPrevious, onNext]);
}
