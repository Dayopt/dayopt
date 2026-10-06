// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../../messages/en/search.json';
import ja from '../../../../../messages/ja/search.json';

const state = vi.hoisted(() => ({ query: 'needle', results: [] as object[] }));
vi.mock('@dayopt/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`q=${state.query}`),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@web/features/search/search-client', () => ({
  fetchSearchResults: async () => state.results,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@dayopt/components', () => ({
  Container: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Heading: ({ children, as: Tag = 'h1' }: { children: ReactNode; as?: 'h1' | 'h3' }) => (
    <Tag>{children}</Tag>
  ),
  Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import SearchPage from './page';

afterEach(cleanup);

it.each([
  ['en', en, 'No search results found', 'Clear search', 'All (0)'],
  ['ja', ja, '検索結果が見つかりませんでした', '検索をクリア', 'すべて (0)'],
] as const)(
  'renders empty results and filters in %s',
  async (locale, messages, empty, clear, all) => {
    state.results = [];
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <SearchPage />
      </NextIntlClientProvider>,
    );
    await screen.findByRole('heading', { name: empty });
    expect(screen.getByRole('button', { name: clear })).toBeTruthy();
    expect(screen.getByRole('button', { name: all })).toBeTruthy();
  },
);

it.each([
  ['en', en, 'View details →', 'Docs (1)', 'Last updated: 2026-10-01'],
  ['ja', ja, '詳細を見る →', 'ドキュメント (1)', '最終更新: 2026-10-01'],
] as const)(
  'renders result actions and dates in %s',
  async (locale, messages, details, filter, updated) => {
    state.results = [
      {
        id: 'example',
        title: 'needle',
        description: 'Example',
        type: 'docs',
        url: '/docs/plans',
        breadcrumbs: [],
        lastModified: '2026-10-01',
      },
    ];
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <SearchPage />
      </NextIntlClientProvider>,
    );
    await screen.findByRole('link', { name: details });
    expect(screen.getByRole('button', { name: filter })).toBeTruthy();
    expect(screen.getByText(updated)).toBeTruthy();
  },
);
