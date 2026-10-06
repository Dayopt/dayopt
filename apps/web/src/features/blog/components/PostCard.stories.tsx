import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';
import ja from '../../../../messages/ja/common.json';
import type { BlogPostMeta } from '../lib/blog';
import { PostCard } from './PostCard';

const post = {
  slug: 'timeboxing-guide',
  frontMatter: {
    title: '時間を見つめ直す。日々の余白をつくるためのタイムボクシング入門',
    description: '予定と実際に使った時間を並べて、自分に合った一日のかたちを考えます。',
    publishedAt: '2026-05-26',
    author: 'Dayopt',
    category: 'guide',
    tags: [],
    draft: false,
    featured: false,
  },
  excerpt: '',
  readingTime: 6,
} satisfies BlogPostMeta;
const meta = {
  title: 'Web/Content/PostCard',
  component: PostCard,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="ja" messages={ja}>
        <Story />
      </NextIntlClientProvider>
    ),
  ],
  args: { post, locale: 'ja', layout: 'vertical' },
} satisfies Meta<typeof PostCard>;
export default meta;
type Story = StoryObj<typeof meta>;
/** 最新記事を大きく表示する。 */
export const Featured: Story = { args: { layout: 'featured' } };
/** 長い見出しと画像未設定を含む一覧。 */
export const AllPatterns: Story = {
  render: (args) => (
    <div className="space-y-8">
      <PostCard {...args} layout="featured" />
      <div className="grid gap-6 sm:grid-cols-2">
        <PostCard {...args} />
        <PostCard
          {...args}
          post={{
            ...post,
            slug: 'second-story',
            frontMatter: { ...post.frontMatter, title: '予定と記録から、一日を知る。' },
          }}
        />
      </div>
      <PostCard {...args} layout="horizontal" />
    </div>
  ),
};
