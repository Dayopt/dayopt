import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DisplaySettings } from './DisplaySettings';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  updateMutate: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));
vi.mock('@/lib/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));
vi.mock('@/lib/hooks/useUpdateUserSettings', () => ({
  useUpdateUserSettings: () => ({ mutate: mocks.updateMutate, isPending: false }),
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: () => '/calendar',
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
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

describe('DisplaySettings language', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('言語を変えると URL locale と一緒に preferred_locale も保存する', () => {
    render(<DisplaySettings />);
    const trigger = screen.getByRole('combobox', { name: 'settings.preferences.language' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
    const option = screen.getByRole('option', { name: /English/ });
    fireEvent.click(option);

    expect(mocks.updateMutate).toHaveBeenCalledWith({ preferredLocale: 'en' });
    expect(mocks.replace).toHaveBeenCalledWith('/calendar', { locale: 'en' });
  });
});
