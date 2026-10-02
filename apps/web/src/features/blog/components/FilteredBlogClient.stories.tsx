import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';
import { expect, userEvent, within } from 'storybook/test';
import ja from '../../../../messages/ja/common.json';
import type { BlogPostMeta } from '../lib/blog';
import { FilteredBlogClient } from './FilteredBlogClient';

const initialPosts: BlogPostMeta[] = [
  {
    slug: 'first',
    frontMatter: {
      title: '予定と記録から、時間を知る',
      description: '予定と実際の時間を見つめる記事。',
      category: 'guide',
      author: 'Dayopt',
      publishedAt: '2026-05-26',
      tags: [],
      draft: false,
      featured: false,
    },
    excerpt: '',
    readingTime: 5,
  },
  {
    slug: 'second',
    frontMatter: {
      title: '余白のある一日を考える',
      description: '日々の余白を考える記事。',
      category: 'philosophy',
      author: 'Dayopt',
      publishedAt: '2026-05-25',
      tags: [],
      draft: false,
      featured: false,
    },
    excerpt: '',
    readingTime: 3,
  },
];
const meta = {
  title: 'Web/Content/BlogIndex',
  component: FilteredBlogClient,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="ja" messages={ja}>
        <Story />
      </NextIntlClientProvider>
    ),
  ],
  args: { initialPosts, locale: 'ja', currentPage: 1 },
} satisfies Meta<typeof FilteredBlogClient>;
export default meta;
type Story = StoryObj<typeof meta>;
/** 最新記事と記事一覧を含む表示。 */
export const AllPatterns: Story = {};
/** 検索後だけ記事が絞られ、クリア後に戻る。 */
export const Filter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText('タイトル、内容、タグで検索...');
    await userEvent.type(input, '予定');
    await expect(
      canvas.queryByRole('heading', { name: '余白のある一日を考える' }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByRole('heading', { name: '予定と記録から、時間を知る' })).toBeVisible();
    await userEvent.clear(input);
    await expect(canvas.getByRole('heading', { name: '余白のある一日を考える' })).toBeVisible();
  },
};
