import { Button } from '@dayopt/components';
import { getDocHref } from '@web/lib/mdx';
import { ContentData } from '@web/types/content';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

interface PageNavigationProps {
  previousPage?: ContentData;
  nextPage?: ContentData;
}

export async function PageNavigation({ previousPage, nextPage }: PageNavigationProps) {
  if (!previousPage && !nextPage) {
    return null;
  }

  const t = await getTranslations('docs.pageNavigation');

  return (
    <div className="border-border mt-12 border-t pt-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row">
        {/* Previous Page */}
        <div className="flex-1">
          {previousPage && (
            <Button
              variant="outline"
              size="lg"
              asChild
              className="h-auto w-full justify-start px-4 py-4"
            >
              <Link href={getDocHref(previousPage)}>
                <ChevronLeft className="mr-2 size-4 shrink-0" />
                <div className="text-left">
                  <div className="text-muted-foreground text-xs">{t('previous')}</div>
                  <div className="text-foreground text-sm font-medium whitespace-normal">
                    {previousPage.frontMatter.title}
                  </div>
                </div>
              </Link>
            </Button>
          )}
        </div>

        {/* Next Page */}
        <div className="flex-1">
          {nextPage && (
            <Button
              variant="outline"
              size="lg"
              asChild
              className="h-auto w-full justify-end px-4 py-4"
            >
              <Link href={getDocHref(nextPage)}>
                <div className="text-right">
                  <div className="text-muted-foreground text-xs">{t('next')}</div>
                  <div className="text-foreground text-sm font-medium whitespace-normal">
                    {nextPage.frontMatter.title}
                  </div>
                </div>
                <ChevronRight className="ml-2 size-4 shrink-0" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
