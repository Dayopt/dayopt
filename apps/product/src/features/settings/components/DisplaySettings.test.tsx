import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DisplaySettings } from './DisplaySettings';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));
vi.mock('@/lib/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: () => '/calendar',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../hooks/useUserSettings', () => ({
  useUserSettings: () => ({
    isPending: false,
    saveSettings: vi.fn(),
    settings: {
      timezone: 'Asia/Tokyo',
      timeFormat: '24h',
      weekStartsOn: 1,
      defaultView: 'week',
      defaultDuration: 60,
      showWeekends: true,
      showWeekNumbers: false,
      hourHeightDensity: 'default',
    },
  }),
}));

describe('DisplaySettings accessible controls', () => {
  it('names each selector independently of its selected value', () => {
    render(<DisplaySettings />);
    for (const name of [
      'settings.preferences.language',
      'settings.preferences.themeLabel',
      'settings.calendar.timezone',
      'settings.calendar.timeFormat',
      'settings.calendar.weekStartsOn',
      'settings.calendar.defaultView',
      'settings.calendar.defaultDuration',
      'settings.calendar.density',
    ]) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
  });
});
