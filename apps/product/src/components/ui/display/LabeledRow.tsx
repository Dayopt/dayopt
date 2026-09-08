'use client';

import {
  Children,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useId,
} from 'react';

import { ChevronRight } from 'lucide-react';

import { cn } from '@dayopt/components';

type LabeledRowVariant = 'control' | 'navigate' | 'action' | 'display';

interface LabeledRowProps {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** 行のバリアント: control(デフォルト), navigate(遷移), action(破壊的), display(表示のみ) */
  variant?: LabeledRowVariant;
  /** navigate variant時のクリックハンドラ */
  onClick?: () => void;
}

/**
 * 設定画面の行コンポーネント（2カラム: ラベル | コントロール）
 *
 * - min-h-11 (44px) でタッチターゲット保証
 * - variant="navigate" で ChevronRight 自動表示 + 行タップ可能
 * - variant="action" で destructive カラー
 * - control variant の子要素に aria-labelledby を自動注入（a11y）
 *
 * 現在は主に Settings の設定系UIで使用。
 */
export function LabeledRow({
  label,
  description,
  children,
  variant = 'control',
  onClick,
}: LabeledRowProps) {
  const autoLabelId = useId();
  const isNavigate = variant === 'navigate';
  const isAction = variant === 'action';
  const isControl = variant === 'control';

  // control variant の子要素に aria-labelledby を自動注入
  const enhancedChildren =
    isControl && children
      ? Children.map(children, (child) => {
          if (!isValidElement(child)) return child;
          const props = child.props as Record<string, unknown>;
          // 既に aria-label / aria-labelledby を持つ要素はスキップ
          if (props['aria-label'] || props['aria-labelledby']) return child;
          return cloneElement(child as ReactElement<Record<string, unknown>>, {
            'aria-labelledby': autoLabelId,
          });
        })
      : children;

  const content = (
    <div
      className={cn(
        'flex min-h-11 items-center gap-4 py-2',
        isNavigate && 'active:bg-state-pressed cursor-pointer',
        isAction && 'cursor-pointer',
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          id={isControl ? autoLabelId : undefined}
          className={cn('text-base', isAction && 'text-destructive')}
        >
          {label}
        </div>
        {description ? (
          <div className="text-muted-foreground mt-1 text-sm">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {enhancedChildren}
        {isNavigate && <ChevronRight className="text-muted-foreground size-4" />}
      </div>
    </div>
  );

  if ((isNavigate || isAction) && onClick) {
    return (
      <button
        type="button"
        className="hover:bg-state-hover focus-visible:ring-ring w-full rounded-lg text-left focus-visible:ring-2 focus-visible:outline-hidden"
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return content;
}
