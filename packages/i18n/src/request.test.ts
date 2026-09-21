import { describe, expect, it, vi } from 'vitest';

import { createI18nRequestConfig, type MessageLoader } from './request';

vi.mock('next-intl/server', () => ({
  getRequestConfig: (
    createRequestConfig: (params: { requestLocale: Promise<string | undefined> }) => unknown,
  ) => createRequestConfig,
}));

async function resolveRequest(requestLocale: string | undefined) {
  const loader: MessageLoader = vi.fn(async (locale) => ({ loadedLocale: locale }));
  const requestConfig = createI18nRequestConfig(loader);
  const config = await requestConfig({ requestLocale: Promise.resolve(requestLocale) });

  return { config, loader };
}

describe('createI18nRequestConfig', () => {
  it('有効な locale を loader に渡す', async () => {
    const { config, loader } = await resolveRequest('ja');

    expect(config).toEqual({ locale: 'ja', messages: { loadedLocale: 'ja' } });
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('ja');
  });

  it('不正 locale は default locale にフォールバックする', async () => {
    const { config, loader } = await resolveRequest('fr');

    expect(config).toEqual({ locale: 'en', messages: { loadedLocale: 'en' } });
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('en');
  });
});
