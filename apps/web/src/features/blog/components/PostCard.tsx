'use client';

import { Link } from '@dayopt/i18n/navigation';
import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BlogPostMeta } from '../lib/blog';
import { isBlogCategoryKey } from '../lib/categories';
import styles from './BlogDesign.module.css';
import { BlogImage } from './BlogImage';

interface PostCardProps {
  post: BlogPostMeta;
  priority?: boolean;
  layout?: 'horizontal' | 'vertical' | 'list' | 'featured';
  locale?: string;
}

export function PostCard({
  post,
  priority = false,
  layout = 'horizontal',
  locale = 'en',
}: PostCardProps) {
  const t = useTranslations('blog');
  const categoryKey = post.frontMatter.category.toLowerCase();
  const categoryLabel = isBlogCategoryKey(categoryKey)
    ? t(`tabs.${categoryKey}`)
    : post.frontMatter.category;
  const variant = [...post.slug].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
  return (
    <article className={styles.post} data-layout={layout}>
      <Link href={`/blog/${post.slug}`} className={styles.postLink}>
        <div className={styles.postImage}>
          <BlogImage
            src={post.frontMatter.coverImage}
            alt=""
            priority={priority}
            variant={variant}
            sizes={
              layout === 'featured'
                ? '(max-width: 768px) 100vw, 60vw'
                : '(max-width: 768px) 100vw, 33vw'
            }
          />
        </div>
        <div className={styles.postCopy}>
          <div className={styles.postKicker}>
            <span>{categoryLabel}</span>
            {layout === 'featured' && <span>{t('header.latest')}</span>}
          </div>
          <h2>{post.frontMatter.title}</h2>
          <p className={styles.postDescription}>{post.frontMatter.description || post.excerpt}</p>
          <div className={styles.postMeta}>
            <time dateTime={post.frontMatter.publishedAt}>
              {new Date(post.frontMatter.publishedAt).toLocaleDateString(locale, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </time>
            <span>{t('post.readingTime', { minutes: post.readingTime })}</span>
          </div>
          <span className={styles.readLink}>
            {t('post.read')}
            <ArrowUpRight size={16} aria-hidden="true" />
          </span>
        </div>
      </Link>
    </article>
  );
}
