'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@dayopt/components';
import { usePathname, useRouter } from '@dayopt/i18n/navigation';
import { routing, type Locale } from '@dayopt/i18n/routing';
import { ChevronDown, Globe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

const localeLabels: Record<Locale, string> = {
  en: 'EN',
  ja: 'JA',
};

const localeNames: Record<Locale, string> = {
  en: 'English',
  ja: '日本語',
};

interface LanguageSwitcherProps {
  /** 表示形式: 'short' = EN/JA, 'full' = English/日本語 */
  variant?: 'short' | 'full';
  className?: string;
}

export function LanguageSwitcher({ variant = 'short', className }: LanguageSwitcherProps) {
  const t = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const handleLocaleChange = (newLocale: Locale) => {
    router.replace(pathname, { locale: newLocale });
  };

  const currentLabel = variant === 'full' ? localeNames[locale] : localeLabels[locale];

  if (!mounted) {
    return (
      <Button variant="ghost" size="default" disabled className={className}>
        <Globe className="size-4" />
        <span>{currentLabel}</span>
        <ChevronDown className="size-3" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="default"
          aria-label={`${currentLabel} - ${t('aria.changeLanguage')}`}
          className={className}
        >
          <Globe className="size-4" />
          <span>{currentLabel}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {routing.locales.map((loc) => (
          <DropdownMenuCheckboxItem
            key={loc}
            checked={locale === loc}
            onCheckedChange={() => handleLocaleChange(loc)}
          >
            {localeNames[loc]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
