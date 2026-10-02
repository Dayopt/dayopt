export interface CookieConsentBannerCopy {
  title: string;
  description: string;
  learnMoreLabel: string;
  learnMoreHref: string;
  necessaryOnlyLabel: string;
  allowAnalyticsLabel: string;
}

export const cookieSettingsCopyKeys = [
  'settings.status.unset',
  'settings.status.allowed',
  'settings.status.refused',
  'settings.trigger',
  'settings.revokeConfirmTitle',
  'settings.revokeConfirmDescription',
  'settings.saveFailed',
  'settings.revokeCancelLabel',
  'settings.revokeConfirmLabel',
  'settings.title',
  'settings.independentOrigins',
  'banner.learnMore',
  'banner.necessaryOnly',
  'banner.allowAnalytics',
] as const;

export type CookieSettingsCopy = Record<(typeof cookieSettingsCopyKeys)[number], string> & {
  learnMoreHref: string;
};
