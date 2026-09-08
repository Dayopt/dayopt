'use client';

import { useCallback } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useTheme } from '@/lib/hooks/useTheme';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from '@dayopt/components';
import { usePathname, useRouter } from '@dayopt/i18n/navigation';
import { routing, type Locale } from '@dayopt/i18n/routing';

import { getTimeZones } from '@/lib/timezone-utils';
import { useUserSettings } from '../hooks/useUserSettings';

import { LabeledRow } from '@/components/ui/display/LabeledRow';
import { SectionCard } from '@/components/ui/display/SectionCard';

/**
 * 表示設定コンポーネント
 *
 * テーマ、言語、TZ、時間形式、週開始、デフォルトView、デフォルトduration
 */
export function DisplaySettings() {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { settings, saveSettings, isPending } = useUserSettings();

  const handleLanguageChange = useCallback(
    (value: string) => {
      const newLocale = value as Locale;
      if (newLocale !== locale) {
        router.replace(pathname, { locale: newLocale });
        router.refresh();
      }
    },
    [locale, pathname, router],
  );

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value as 'system' | 'light' | 'dark');
    },
    [setTheme],
  );

  const handleTimezoneChange = useCallback(
    (value: string) => {
      saveSettings({ timezone: value });
    },
    [saveSettings],
  );

  const handleTimeFormatChange = useCallback(
    (value: string) => {
      saveSettings({ timeFormat: value as '12h' | '24h' });
    },
    [saveSettings],
  );

  const handleWeekStartsOnChange = useCallback(
    (value: string) => {
      saveSettings({ weekStartsOn: Number(value) as 0 | 1 | 6 });
    },
    [saveSettings],
  );

  const handleDefaultViewChange = useCallback(
    (value: string) => {
      saveSettings({ defaultView: value as 'day' | '3day' | '5day' | 'week' });
    },
    [saveSettings],
  );

  const handleDefaultDurationChange = useCallback(
    (value: string) => {
      saveSettings({ defaultDuration: Number(value) });
    },
    [saveSettings],
  );

  const handleDensityChange = useCallback(
    (value: string) => {
      saveSettings({ hourHeightDensity: value as 'compact' | 'default' | 'spacious' });
    },
    [saveSettings],
  );

  const handleShowWeekendsChange = useCallback(
    (checked: boolean) => {
      saveSettings({ showWeekends: checked });
    },
    [saveSettings],
  );

  const handleShowWeekNumbersChange = useCallback(
    (checked: boolean) => {
      saveSettings({ showWeekNumbers: checked });
    },
    [saveSettings],
  );

  if (isPending) {
    return (
      <div className="space-y-6 sm:space-y-8">
        {Array.from({ length: 3 }, (_, i) => (
          <SectionCard key={i}>
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          </SectionCard>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Language & Theme */}
      <SectionCard title={t('settings.preferences.languageAndTheme')}>
        <LabeledRow label={t('settings.preferences.language')}>
          <Select value={locale} onValueChange={handleLanguageChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.preferences.language')}>
              <SelectValue placeholder={t('settings.preferences.selectLanguage')} />
            </SelectTrigger>
            <SelectContent>
              {routing.locales.map((loc) => (
                <SelectItem key={loc} value={loc}>
                  {loc === 'ja' ? '日本語' : 'English'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledRow>
        <LabeledRow label={t('settings.preferences.themeLabel')}>
          <Select value={theme} onValueChange={handleThemeChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.preferences.themeLabel')}>
              <SelectValue placeholder={t('settings.preferences.selectTheme')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.preferences.themeSystem')}</SelectItem>
              <SelectItem value="light">{t('settings.preferences.themeLight')}</SelectItem>
              <SelectItem value="dark">{t('settings.preferences.themeDark')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
      </SectionCard>

      {/* Region & Format */}
      <SectionCard title={t('settings.calendar.timeAndTimezone')}>
        <LabeledRow label={t('settings.calendar.timezone')}>
          <Select value={settings.timezone} onValueChange={handleTimezoneChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.timezone')}>
              <SelectValue placeholder={t('settings.calendar.selectTimezone')} />
            </SelectTrigger>
            <SelectContent>
              {getTimeZones().map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.timeFormat')}>
          <Select value={settings.timeFormat} onValueChange={handleTimeFormatChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.timeFormat')}>
              <SelectValue placeholder={t('settings.calendar.selectTimeFormat')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">{t('settings.calendar.timeFormat24h')}</SelectItem>
              <SelectItem value="12h">{t('settings.calendar.timeFormat12h')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.weekStartsOn')}>
          <Select value={String(settings.weekStartsOn)} onValueChange={handleWeekStartsOnChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.weekStartsOn')}>
              <SelectValue placeholder={t('settings.calendar.selectStartDay')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('settings.calendar.sunday')}</SelectItem>
              <SelectItem value="1">{t('settings.calendar.monday')}</SelectItem>
              <SelectItem value="6">{t('settings.calendar.saturday')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
      </SectionCard>

      {/* Default View & Duration */}
      <SectionCard title={t('settings.calendar.defaultViewSection')}>
        <LabeledRow label={t('settings.calendar.defaultView')}>
          <Select value={settings.defaultView} onValueChange={handleDefaultViewChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.defaultView')}>
              <SelectValue placeholder={t('settings.calendar.selectDefaultView')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{t('settings.calendar.viewDay')}</SelectItem>
              <SelectItem value="3day">{t('settings.calendar.view3Day')}</SelectItem>
              <SelectItem value="5day">{t('settings.calendar.view5Day')}</SelectItem>
              <SelectItem value="week">{t('settings.calendar.viewWeek')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.defaultDuration')}>
          <Select
            value={String(settings.defaultDuration)}
            onValueChange={handleDefaultDurationChange}
          >
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.defaultDuration')}>
              <SelectValue placeholder={t('settings.calendar.selectDuration')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">{t('settings.calendar.duration15min')}</SelectItem>
              <SelectItem value="30">{t('settings.calendar.duration30min')}</SelectItem>
              <SelectItem value="60">{t('settings.calendar.duration1hour')}</SelectItem>
              <SelectItem value="90">{t('settings.calendar.duration1hour30min')}</SelectItem>
              <SelectItem value="120">{t('settings.calendar.duration2hours')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.showWeekends')}>
          <Switch checked={settings.showWeekends} onCheckedChange={handleShowWeekendsChange} />
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.showWeekNumbers')}>
          <Switch
            checked={settings.showWeekNumbers}
            onCheckedChange={handleShowWeekNumbersChange}
          />
        </LabeledRow>
        <LabeledRow label={t('settings.calendar.density')}>
          <Select value={settings.hourHeightDensity} onValueChange={handleDensityChange}>
            <SelectTrigger variant="ghost" aria-label={t('settings.calendar.density')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">{t('settings.calendar.densityCompact')}</SelectItem>
              <SelectItem value="default">{t('settings.calendar.densityDefault')}</SelectItem>
              <SelectItem value="spacious">{t('settings.calendar.densitySpacious')}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledRow>
      </SectionCard>
    </div>
  );
}
