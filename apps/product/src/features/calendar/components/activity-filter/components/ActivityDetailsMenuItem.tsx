'use client';

import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DropdownMenuItem } from '@dayopt/components';

interface ActivityDetailsMenuItemProps {
  onViewActivityDetails: () => void;
}

export function ActivityDetailsMenuItem({ onViewActivityDetails }: ActivityDetailsMenuItemProps) {
  const t = useTranslations();

  return (
    <DropdownMenuItem onClick={onViewActivityDetails}>
      <BarChart3 className="size-4" />
      {t('calendar.filter.viewActivityDetails')}
    </DropdownMenuItem>
  );
}
