'use client';

import { useTranslations } from 'next-intl';

import type { TimeblockDestination } from '../../domain/timeblock-destination';
import type { TimeblockMenuItem } from '../../lib/timeblock-menu-items';
import { InspectorHeaderActions } from '../inspector/fields';

interface TimeblockInspectorHeaderProps {
  kind: TimeblockDestination;
  menuItems?: TimeblockMenuItem[] | undefined;
  onCloseInspector?: (() => void) | undefined;
  disabled?: boolean | undefined;
}

/** 予定 / 記録の種別ラベルとヘッダー操作を表示する。 */
export function TimeblockInspectorHeader({
  kind,
  menuItems,
  onCloseInspector,
  disabled,
}: TimeblockInspectorHeaderProps) {
  const t = useTranslations();
  const kindLabel =
    kind === 'plan' ? t('timeblock.inspector.kind.plan') : t('timeblock.inspector.kind.record');

  return (
    <div className="flex h-14 shrink-0 items-center justify-between px-2">
      <div className="flex min-w-0 items-center pl-2">
        <span className="text-foreground text-sm font-medium">{kindLabel}</span>
      </div>
      <InspectorHeaderActions
        menuItems={menuItems}
        onCloseInspector={onCloseInspector}
        disabled={disabled}
      />
    </div>
  );
}
