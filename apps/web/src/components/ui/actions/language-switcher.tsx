'use client';

import { usePathname, useRouter } from '@dayopt/i18n/navigation';
import { routing, type Locale } from '@dayopt/i18n/routing';
import { Globe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import styles from './PreferenceSelect.module.css';

const localeLabels: Record<Locale, string> = { en: 'EN', ja: 'JA' };
const localeNames: Record<Locale, string> = { en: 'English', ja: '日本語' };

interface LanguageSwitcherProps {
  variant?: 'short' | 'full';
  className?: string;
}

export function LanguageSwitcher({ variant = 'short', className }: LanguageSwitcherProps) {
  const t = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale() as Locale;

  return (
    <div className={[styles.control, className].filter(Boolean).join(' ')}>
      <Globe aria-hidden="true" />
      <select
        aria-label={t('aria.changeLanguage')}
        value={locale}
        onChange={(event) => router.replace(pathname, { locale: event.target.value as Locale })}
      >
        {routing.locales.map((option) => (
          <option key={option} value={option} lang={option}>
            {variant === 'full' ? localeNames[option] : localeLabels[option]}
          </option>
        ))}
      </select>
    </div>
  );
}
