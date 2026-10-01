import design from '@web/components/content/ContentDesign.module.css';
import { FAQStructuredData } from '@web/components/seo/EnhancedSEO';
import { ContentData } from '@web/types/content';
import { getTranslations } from 'next-intl/server';
import { MDXRemote } from 'next-mdx-remote/rsc';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { faqMdxComponents, mdxComponents } from './MDXComponents';
import { PageNavigation } from './PageNavigation';
import { TableOfContentsCards } from './TableOfContentsCards';

/**
 * MDXソースからFAQ（h2 = 質問、本文 = 回答）を抽出
 */
function extractFAQsFromMDX(content: string): Array<{ question: string; answer: string }> {
  const faqs: Array<{ question: string; answer: string }> = [];
  const lines = content.split('\n');
  let currentQuestion = '';
  let currentAnswer = '';

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentQuestion && currentAnswer) {
        faqs.push({ question: currentQuestion, answer: currentAnswer.trim() });
      }
      currentQuestion = line.replace('## ', '');
      currentAnswer = '';
    } else if (currentQuestion && line.trim()) {
      currentAnswer += line + ' ';
    }
  }
  if (currentQuestion && currentAnswer) {
    faqs.push({ question: currentQuestion, answer: currentAnswer.trim() });
  }
  return faqs;
}

interface DocArticleProps {
  category: string;
  mdxContent: string;
  previousPage?: ContentData;
  nextPage?: ContentData;
}

/**
 * docs 記事の本文 + ページ送り + 右側目次（blog と共通の2card）を描画する。
 * `/docs/[slug]` と `/docs`（はじめに Overview をデフォルト表示）の両方から使う。
 */
export async function DocArticle({
  category,
  mdxContent,
  previousPage,
  nextPage,
}: DocArticleProps) {
  const isFAQ = category === 'faq';
  const t = await getTranslations('docs');

  return (
    <div className={`${design.docsArticle} ${design.articleLayout}`}>
      {/* Main Content */}
      <div className={design.articleBody}>
        <div>
          <div className={design.docKicker}>
            <span aria-hidden="true">D /</span>
            <span>{t('guide')}</span>
          </div>
          {/* FAQ構造化データ */}
          {isFAQ &&
            (() => {
              const faqs = extractFAQsFromMDX(mdxContent);
              return faqs.length > 0 ? <FAQStructuredData faqs={faqs} /> : null;
            })()}

          {/* MDX content */}
          <article>
            <MDXRemote
              source={mdxContent}
              components={isFAQ ? faqMdxComponents : mdxComponents}
              options={{
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [rehypeHighlight],
                },
              }}
            />
          </article>

          {/* Previous/next page navigation */}
          <PageNavigation previousPage={previousPage} nextPage={nextPage} />
        </div>
      </div>

      {/* Right Sidebar - Table of Contents（xl以上で表示。blog と共通の2card レイアウト） */}
      <aside className={design.articleAside}>
        <div>
          <TableOfContentsCards content={mdxContent} />
        </div>
      </aside>
    </div>
  );
}
