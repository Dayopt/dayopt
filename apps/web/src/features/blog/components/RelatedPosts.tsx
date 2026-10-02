'use client';

import { Heading, Text } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import design from '@web/components/content/ContentDesign.module.css';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BlogPostMeta } from '../lib/blog';
import { PostCard } from './PostCard';

interface RelatedPostsProps {
  posts: BlogPostMeta[];
  currentSlug: string;
  locale?: string;
}

export function RelatedPosts({
  posts,
  currentSlug: _currentSlug,
  locale = 'en',
}: RelatedPostsProps) {
  const t = useTranslations('blog.relatedPosts');

  if (posts.length === 0) {
    return null;
  }

  return (
    <section className="bg-muted border-border border-t">
      <div className={design.page}>
        <div className="mx-auto max-w-6xl">
          <div className="mb-12">
            <Heading as="h2" size="2xl" className="mb-4">
              {t('title')}
            </Heading>
            <Text size="lg" variant="muted">
              {t('subtitle')}
            </Text>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
            {posts.slice(0, 3).map((post) => (
              <PostCard
                key={post.slug}
                post={post}
                priority={false}
                layout="vertical"
                locale={locale}
              />
            ))}
          </div>

          {/* View all articles link */}
          <div className="mt-12 text-center">
            {/* lint-tokens-allow: ボタン風リンク。Button の outline variant と同じく
                素の border-border を使い、hover で border-foreground へ遷移する */}
            <Link
              href="/blog"
              className="border-border bg-card text-foreground hover:border-foreground hover:bg-muted inline-flex items-center rounded-lg border px-6 py-4 text-sm font-medium shadow-sm transition-colors"
            >
              {t('viewAll')}
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
