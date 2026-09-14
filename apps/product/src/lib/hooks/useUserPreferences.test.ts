import { describe, expect, it } from 'vitest';

import { toUserPreferences } from './useUserPreferences';

const SETTINGS = {
  timezone: 'Asia/Tokyo',
  timeFormat: '12h' as const,
  weekStartsOn: 0 as const,
  showWeekends: true,
  showWeekNumbers: true,
  defaultDuration: 30,
  defaultView: 'week' as const,
  hourHeightDensity: 'default' as const,
  theme: 'system' as const,
  personalization: {
    dismissedTrialEndedDialog: false,
    paymentErrorDialogLastShownAt: null,
  },
  preferredLocale: 'ja' as const,
};

describe('toUserPreferences', () => {
  it('user_settings query responseをapp-wide preferenceへ変換する', () => {
    expect(toUserPreferences(SETTINGS, 'ja')).toEqual({
      timezone: 'Asia/Tokyo',
      timeFormat: '12h',
      dateFormat: 'yyyy/MM/dd',
      weekStartsOn: 0,
      showWeekNumbers: true,
      defaultDuration: 30,
    });
  });

  it('日付表記はpreferredLocaleではなく画面のlocaleに従う', () => {
    expect(toUserPreferences({ ...SETTINGS, preferredLocale: 'en' }, 'ja').dateFormat).toBe(
      'yyyy/MM/dd',
    );
    expect(toUserPreferences(SETTINGS, 'en').dateFormat).toBe('MM/dd/yyyy');
  });

  it('row未作成時は安全なdefaultを返す', () => {
    expect(toUserPreferences(null, 'ja')).toMatchObject({
      timeFormat: '24h',
      dateFormat: 'yyyy-MM-dd',
      weekStartsOn: 1,
      showWeekNumbers: false,
      defaultDuration: 60,
    });
  });
});
