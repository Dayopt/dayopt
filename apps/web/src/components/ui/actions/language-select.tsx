'use client';

import { routing, type Locale } from '@dayopt/i18n/routing';
import { Globe } from 'lucide-react';

import styles from './PreferenceSelect.module.css';

const localeLabels: Record<Locale, string> = { en: 'EN', ja: 'JA' };
const localeNames: Record<Locale, string> = { en: 'English', ja: '日本語' };

export interface LanguageSwitcherProps {
  variant?: 'short' | 'full';
  className?: string;
}

export function LanguageSelect({
  label,
  locale,
  variant = 'short',
  className,
}: LanguageSwitcherProps & { label: string; locale: Locale }) {
  return (
    <div className={[styles.control, className].filter(Boolean).join(' ')}>
      <Globe aria-hidden="true" />
      <select
        aria-label={label}
        value={locale}
        onChange={(event) => {
          const pathname = window.location.pathname.replace(/^\/(ja|en)(?=\/|$)/, '') || '/';
          // Explicit prefix lets locale middleware persist the choice, then canonicalize English.
          window.location.replace(`/${event.target.value}${pathname === '/' ? '' : pathname}`);
        }}
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
