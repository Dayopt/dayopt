'use client';

import { useTranslations } from 'next-intl';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@dayopt/components';

export function ActivitySummarySheet({
  open,
  content,
  onClose,
}: {
  open: boolean;
  content: React.ReactNode;
  onClose: () => void;
}) {
  const t = useTranslations('activities.activitySummary');
  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
      <DrawerContent data-activity-summary-sheet="true">
        <DrawerTitle className="sr-only">{t('ariaLabel')}</DrawerTitle>
        <DrawerDescription className="sr-only">{t('ariaLabel')}</DrawerDescription>
        {/* eslint-disable-next-line tailwindcss/no-arbitrary-value -- detail sheet uses the drawer's 80vh viewport cap */}
        <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-4">{content}</div>
      </DrawerContent>
    </Drawer>
  );
}
