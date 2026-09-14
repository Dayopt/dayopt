export const dayoptDomains = {
  marketing: 'dayopt.app',
  product: 'app.dayopt.app',
  mcp: 'mcp.dayopt.app',
  www: 'www.dayopt.app',
} as const;

export const dayoptUrls = {
  marketing: `https://${dayoptDomains.marketing}`,
  product: `https://${dayoptDomains.product}`,
  mcp: `https://${dayoptDomains.mcp}`,
  docs: `https://${dayoptDomains.marketing}/docs`,
  www: `https://${dayoptDomains.www}`,
} as const;

export const dayoptContact = {
  supportEmail: 'support@dayopt.app',
  securityEmail: 'security@dayopt.app',
  contactEmail: 'contact@dayopt.app',
} as const;

/** Stable Resend tags used to route contact delivery status to the owning app. */
export const dayoptContactDeliverySources = {
  product: 'contact-product',
  web: 'contact-web',
} as const;

export const dayoptBrand = {
  name: 'Dayopt',
  teamName: 'Dayopt Team',
  platformName: 'Dayopt Platform',
  twitterHandle: '@dayoptapp',
  xUrl: 'https://x.com/dayoptapp',
  githubUrl: 'https://github.com/dayoptapp',
  youtubeUrl: 'https://youtube.com/@dayoptapp',
} as const;

export type DayoptUrlBase = string;

export function createDayoptUrl(base: DayoptUrlBase, path = ''): string {
  if (!path || path === '/') return base;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export const dayoptProductUrls = {
  signup: createDayoptUrl(dayoptUrls.product, '/auth/signup'),
} as const;
