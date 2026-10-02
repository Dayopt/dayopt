import { createContext, useContext, type AnchorHTMLAttributes, type ReactNode } from 'react';

import { useLocale } from 'next-intl';
import { usePathname as useNextPathname, useRouter as useNextRouter } from 'next/navigation';

/** Storybook で再現する next-intl の最小 routing 設定。 */
interface RoutingConfig {
  locales?: readonly string[];
  defaultLocale?: string;
  localePrefix?: 'always' | 'as-needed' | 'never' | { mode?: 'always' | 'as-needed' | 'never' };
}

type QueryValue =
  boolean | number | string | readonly (boolean | number | string)[] | null | undefined;

interface StructuredHref {
  pathname: string;
  query?: Record<string, QueryValue>;
}

type NavigationHref = string | StructuredHref;

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: NavigationHref;
  children: ReactNode;
  locale?: string;
  prefetch?: boolean | null | 'auto';
}

interface GetPathnameArgs {
  forcePrefix?: boolean;
  href: NavigationHref;
  locale: string;
}

const StorybookPathnameContext = createContext<string | null>(null);

/** AllPatterns内で複数routeを同時描画するためのStorybook専用pathname境界。 */
export function StorybookPathnameProvider({
  children,
  pathname,
}: {
  children: ReactNode;
  pathname: string;
}) {
  return (
    <StorybookPathnameContext.Provider value={pathname}>
      {children}
    </StorybookPathnameContext.Provider>
  );
}

/** 個別StoryではNext mock、複合Storyでは最寄りのoverrideを使う。 */
function useStorybookPathname(): string {
  const override = useContext(StorybookPathnameContext);
  const pathname = useNextPathname();
  return override ?? pathname ?? '/';
}

/** pathname の先頭にある対応 locale だけを取り除く。 */
function stripLocalePrefix(pathname: string, locales: readonly string[]): string {
  const [pathWithQuery = '/', hash] = pathname.split('#', 2);
  const [path = '/', query] = pathWithQuery.split('?', 2);
  const segments = path.split('/');
  const firstSegment = segments[1];

  if (firstSegment && locales.includes(firstSegment)) {
    segments.splice(1, 1);
  }

  const normalizedPath = segments.join('/') || '/';
  return `${normalizedPath}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

/** query 値をURLSearchParamsへ一度だけ渡してURLを組み立てる。 */
function resolveHref(href: NavigationHref): string {
  if (typeof href === 'string') return href;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return query ? `${href.pathname}?${query}` : href.pathname;
}

/** 外部URL・hash・特殊schemeはlocale処理の対象外。 */
function isExternalHref(href: string): boolean {
  return href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href);
}

/** routing.localePrefix に従って内部URLをlocalizeする。 */
function localizeHref(
  href: NavigationHref,
  locale: string,
  routing: RoutingConfig,
  forcePrefix?: boolean,
): string {
  const resolvedHref = resolveHref(href);
  if (isExternalHref(resolvedHref)) return resolvedHref;

  const locales = routing.locales ?? ['en', 'ja'];
  const defaultLocale = routing.defaultLocale ?? 'en';
  const prefixMode =
    typeof routing.localePrefix === 'object'
      ? (routing.localePrefix.mode ?? 'always')
      : (routing.localePrefix ?? 'always');
  const localeFreeHref = stripLocalePrefix(resolvedHref, locales);
  const needsPrefix =
    forcePrefix ??
    (prefixMode === 'always' || (prefixMode === 'as-needed' && locale !== defaultLocale));

  if (!needsPrefix) return localeFreeHref;

  return localeFreeHref === '/' ? `/${locale}` : `/${locale}${localeFreeHref}`;
}

/** Storybook用 next-intl/navigation モック。 */
export function createNavigation(routing: RoutingConfig = {}) {
  const locales = routing.locales ?? ['en', 'ja'];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Next Link の制御 prop を DOM に渡さない
  function MockLink({ href, children, locale, prefetch, ...props }: LinkProps) {
    const currentLocale = useLocale();
    const localizedHref = localizeHref(
      href,
      locale ?? currentLocale,
      routing,
      locale != null ? true : undefined,
    );

    return (
      <a href={localizedHref} {...props}>
        {children}
      </a>
    );
  }

  return {
    Link: MockLink,
    redirect: () => undefined,
    usePathname: () => stripLocalePrefix(useStorybookPathname(), locales),
    useRouter: () => {
      const router = useNextRouter();
      const currentLocale = useLocale();

      return {
        ...router,
        push: (href: NavigationHref, options?: { locale?: string; scroll?: boolean }) =>
          router.push(
            localizeHref(
              href,
              options?.locale ?? currentLocale,
              routing,
              options?.locale != null ? true : undefined,
            ),
            {
              scroll: options?.scroll,
            },
          ),
        replace: (href: NavigationHref, options?: { locale?: string; scroll?: boolean }) =>
          router.replace(
            localizeHref(
              href,
              options?.locale ?? currentLocale,
              routing,
              options?.locale != null ? true : undefined,
            ),
            {
              scroll: options?.scroll,
            },
          ),
        prefetch: (href: NavigationHref, options?: { locale?: string }) =>
          router.prefetch(
            localizeHref(
              href,
              options?.locale ?? currentLocale,
              routing,
              options?.locale != null ? true : undefined,
            ),
          ),
      };
    },
    getPathname: ({ forcePrefix, href, locale }: GetPathnameArgs) =>
      localizeHref(href, locale, routing, forcePrefix),
  };
}
