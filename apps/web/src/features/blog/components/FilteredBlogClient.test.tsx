// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlogPostMeta } from '../lib/blog';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('page=2') }));
vi.mock('@dayopt/components', () => ({ cn: (...parts: string[]) => parts.join(' ') }));
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@web/components/ui/feedback/empty-state', () => ({
  EmptyState: () => <p>No articles</p>,
}));
vi.mock('@web/components/ui/inputs/search-input', () => ({
  SearchInput: ({ value, onChange }: { value: string; onChange: (text: string) => void }) => (
    <input
      aria-label="Search articles"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@web/components/ui/navigation/content-pagination', () => ({
  ContentPagination: ({ currentPage }: { currentPage: number }) => <span>Page {currentPage}</span>,
}));
vi.mock('./PostCard', () => ({
  PostCard: ({ post }: { post: BlogPostMeta }) => <article>{post.frontMatter.title}</article>,
}));

import { FilteredBlogClient } from './FilteredBlogClient';

afterEach(cleanup);

it('shows matching articles when searching from the second page', () => {
  const posts = Array.from({ length: 13 }, (_, index) => ({
    slug: `article-${index}`,
    excerpt: '',
    frontMatter: {
      title: index === 0 ? 'Needle article' : `Article ${index}`,
      category: 'guide',
      publishedAt: `2026-09-${String(28 - index).padStart(2, '0')}`,
      description: '',
    },
  })) as BlogPostMeta[];
  render(<FilteredBlogClient initialPosts={posts} locale="en" />);
  expect(screen.getByText('Article 12')).toBeTruthy();
  expect(screen.queryByText('Needle article')).toBeNull();
  fireEvent.change(screen.getByLabelText('Search articles'), { target: { value: 'Needle' } });
  expect(screen.getByText('Needle article')).toBeTruthy();
  expect(screen.queryByText('No articles')).toBeNull();
  fireEvent.change(screen.getByLabelText('Search articles'), { target: { value: '' } });
  expect(screen.getByText('Article 12')).toBeTruthy();
  expect(screen.queryByText('Needle article')).toBeNull();
});
