// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { AutoTableOfContents } from './AutoTableOfContents';
import { TableOfContentsCards } from './TableOfContentsCards';

const CONTENT = '## First heading\n\nBody\n\n## Second heading\n';

function expectNoRepositoryLinks() {
  const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
  expect(hrefs.filter((href) => href.includes('github.com'))).toEqual([]);
}

/**
 * repository は非公開のため、公開 docs / blog の TOC から GitHub（issue / source）へ
 * 誘導しない。問題の報告は誰でも開けるお問い合わせページへ送る。
 */
describe('TOC のリンク', () => {
  afterEach(() => {
    cleanup();
  });

  it('リンク card（docs / blog 記事）は問題の報告をお問い合わせページへ送り、GitHub へ誘導しない', async () => {
    render(<TableOfContentsCards content={CONTENT} />);

    // 目次 card の描画（useEffect 後）を待ってから全リンクを検査する
    await screen.findByText('First heading');

    expect(screen.getByRole('link', { name: 'reportIssue' }).getAttribute('href')).toBe('/contact');
    expect(screen.queryByText('viewSource')).toBeNull();
    expectNoRepositoryLinks();
  });

  it('リンク内包表示（showLinks 既定）でも GitHub へ誘導しない', async () => {
    render(<AutoTableOfContents content={CONTENT} />);

    await screen.findByText('First heading');

    expect(screen.getByRole('link', { name: 'reportIssue' }).getAttribute('href')).toBe('/contact');
    expect(screen.queryByText('viewSource')).toBeNull();
    expectNoRepositoryLinks();
  });
});
