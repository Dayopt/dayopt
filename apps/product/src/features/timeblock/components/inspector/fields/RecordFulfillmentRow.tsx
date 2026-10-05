'use client';

/**
 * 充実度インライン行（Record 専用、#2317）
 *
 * icon + label（左）、3段階のアイコン付きトグルボタン（右）。
 * ワンクリックで選択、もう一回クリックで解除（既定は未入力）。
 * Plan には無い概念なので、TimeblockInspectorForm は kind === 'record' の時だけ描画する。
 */

import { useCallback } from 'react';

import { Frown, Meh, Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@dayopt/components';

import type { Fulfillment } from '../../../schemas/timeblock';

const FULFILLMENT_OPTIONS: { value: Fulfillment; icon: typeof Smile }[] = [
  { value: 'low', icon: Frown },
  { value: 'medium', icon: Meh },
  { value: 'high', icon: Smile },
];

interface RecordFulfillmentRowProps {
  value: Fulfillment | null;
  onChange: (value: Fulfillment | null) => void;
  disabled?: boolean;
}

/** Inspector の充実度入力行（アイコンとテキストの3段階トグル、再クリックで解除） */
export function RecordFulfillmentRow({
  value,
  onChange,
  disabled = false,
}: RecordFulfillmentRowProps) {
  const t = useTranslations('timeblock.editor.fulfillment');

  const handleToggle = useCallback(
    (next: Fulfillment) => {
      onChange(value === next ? null : next);
    },
    [value, onChange],
  );

  return (
    <div className="flex min-h-11 items-center justify-between">
      <div className="flex items-center gap-2">
        <Smile className="text-muted-foreground size-4 flex-shrink-0" />
        <span className="text-muted-foreground text-sm">{t('label')}</span>
      </div>
      {/*
        日付・時間行とは異なり、こちらはテキスト位置ではなくボタンの枠線（border）自体を
        親（bg-muted px-4）のcontent edgeに揃える（User指示）。negative marginは使わない。
      */}
      <div className="flex items-center gap-1">
        {FULFILLMENT_OPTIONS.map(({ value: option, icon: Icon }) => {
          const isSelected = value === option;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => handleToggle(option)}
              aria-pressed={isSelected}
              className={cn(
                'border-border inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-sm font-medium transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                'disabled:pointer-events-none disabled:opacity-50',
                isSelected
                  ? 'bg-state-selected text-foreground'
                  : 'text-muted-foreground hover:bg-state-hover hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {t(`options.${option}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
