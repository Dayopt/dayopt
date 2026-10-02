/// <reference types="vite/client" />
/**
 * Storybook用 next-intl/server モック
 *
 * apps/web の marketing セクションは async Server Component で、
 * `getTranslations`（next-intl/server）から本文を取得する。
 * Storybook には request scope が無いため、web の messages JSON を
 * 同期的に読み込んで `getTranslations` / `setRequestLocale` を再現する。
 *
 * 対応 API: `t(key)` / `t.raw(key)` / `t.has(key)` / `setRequestLocale` / `getLocale`。
 * 既存の next-intl/navigation・next-intl/routing モックと同じ alias 方式（main.ts viteFinal）。
 */

// web の全 namespace（marketing / common / legal / search）を locale ごとに集約
// Next.js 16.3+ が独自の import.meta.glob 型（Turbopack対応）をグローバルに追加し、
// vite/client.d.ts の ImportGlobFunction とマージされ generic 呼び出しが壊れるため、
// ジェネリック引数を渡さず結果を直接キャストする。
const messageModules = import.meta.glob('../../../web/messages/*/*.json', {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const messagesByLocale = Object.entries(messageModules).reduce<
  Record<string, Record<string, unknown>>
>((acc, [filePath, mod]) => {
  // 例: ../../../web/messages/ja/marketing.json → locale = 'ja'
  const match = filePath.match(/\/messages\/([^/]+)\//);
  const locale = match?.[1] ?? 'ja';
  const content = ((mod as { default?: Record<string, unknown> }).default ?? mod) as Record<
    string,
    unknown
  >;
  acc[locale] = { ...(acc[locale] ?? {}), ...content };
  return acc;
}, {});

const DEFAULT_LOCALE = 'ja';

/** ドット区切りキーでネストを解決する。 */
function resolvePath(source: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (value && typeof value === 'object') {
      return (value as Record<string, unknown>)[segment];
    }
    return undefined;
  }, source);
}

interface TranslatorOptions {
  locale?: string;
  namespace?: string;
}

interface Translator {
  (key: string, values?: Record<string, unknown>): string;
  raw: (key: string) => unknown;
  has: (key: string) => boolean;
  markup: (key: string) => string;
  rich: (key: string) => unknown;
}

function createTranslator(locale: string, namespace?: string): Translator {
  const localeMessages = messagesByLocale[locale] ?? messagesByLocale[DEFAULT_LOCALE] ?? {};
  const scope = namespace ? resolvePath(localeMessages, namespace) : localeMessages;

  const t = ((key: string, values?: Record<string, unknown>) => {
    const value = resolvePath(scope, key);
    return typeof value === 'string'
      ? value.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
          values && name in values ? String(values[name]) : placeholder,
        )
      : key;
  }) as Translator;

  t.raw = (key: string) => resolvePath(scope, key);
  t.has = (key: string) => resolvePath(scope, key) !== undefined;
  t.markup = (key: string) => {
    const value = resolvePath(scope, key);
    return typeof value === 'string' ? value : key;
  };
  t.rich = (key: string) => resolvePath(scope, key);

  return t;
}

/** next-intl/server の getTranslations 再現（object 形式・string 形式の両対応）。 */
export async function getTranslations(
  namespaceOrOptions?: string | TranslatorOptions,
): Promise<Translator> {
  if (typeof namespaceOrOptions === 'string') {
    return createTranslator(DEFAULT_LOCALE, namespaceOrOptions);
  }
  const { locale = DEFAULT_LOCALE, namespace } = namespaceOrOptions ?? {};
  return createTranslator(locale, namespace);
}

/** static rendering 用 API。Storybook では no-op。 */
export function setRequestLocale(_locale: string): void {
  // request scope を持たないため何もしない
}

/** 互換用に最小限の追加 API も export する。 */
export async function getLocale(): Promise<string> {
  return DEFAULT_LOCALE;
}

export async function getMessages({ locale = DEFAULT_LOCALE }: { locale?: string } = {}): Promise<
  Record<string, unknown>
> {
  return messagesByLocale[locale] ?? messagesByLocale[DEFAULT_LOCALE] ?? {};
}
