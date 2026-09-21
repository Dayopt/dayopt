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

  it.each(['cards', 'auto'] as const)(
    '%s は GitHub へ誘導せず問い合わせへ送る',
    async (variant) => {
      render(
        variant === 'cards' ? (
          <TableOfContentsCards content={CONTENT} />
        ) : (
          <AutoTableOfContents content={CONTENT} />
        ),
      );

      await screen.findByText('First heading');

      expect(screen.getByRole('link', { name: 'reportIssue' }).getAttribute('href')).toBe(
        '/contact',
      );
      expect(screen.queryByText('viewSource')).toBeNull();
      expectNoRepositoryLinks();
    },
  );
});
