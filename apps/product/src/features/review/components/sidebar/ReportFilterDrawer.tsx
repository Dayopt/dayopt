'use client';

import { useState } from 'react';

import { ListFilter } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  cn,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@dayopt/components';

import { useReportViewStore } from '../../stores/useReportViewStore';
import { ReportFilterList } from './ReportFilterList';

/**
 * モバイルのフィルタ（仕様 §8）。タブ行の右端のボタンと、開いた先の Drawer。
 *
 * 中身はデスクトップのサイドバーと**同じ `ReportFilterList`**。器が違うだけで、
 * 出し入れの単位（カテゴリー / アクティビティ）も store も 1 つに集約する
 * （モバイル専用の集計を作らない = 仕様 §13-13）。
 *
 * 以前はカテゴリー単位のチップ列だった。アクティビティ単位の出し入れがモバイルに無い
 * 非対称と、ヘッダー → タブ → チップの 3 段で本文が始まるまでが重い問題を、
 * タブ行にボタン 1 つを置いて Drawer で同じ一覧を開く形で同時に解いた（2026-09-15 User 裁可）。
 *
 * 何かを外している間はアイコンに点を添える。閉じた Drawer の中の状態が、本文の数字が
 * 小さい理由として外から読めるようにするため。
 */
export function ReportFilterDrawer() {
  const t = useTranslations('report.mobile.filter');
  const [open, setOpen] = useState(false);

  const hiddenCategoryIds = useReportViewStore((state) => state.hiddenCategoryIds);
  const hiddenActivityIds = useReportViewStore((state) => state.hiddenActivityIds);
  const filtering = hiddenCategoryIds.length > 0 || hiddenActivityIds.length > 0;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        icon
        size="sm"
        aria-label={t('open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-report-filter-active={filtering ? 'true' : undefined}
        onClick={() => setOpen(true)}
        className={cn('relative', filtering ? 'text-foreground' : 'text-muted-foreground')}
      >
        <ListFilter className="size-5" />
        {filtering ? (
          <span
            aria-hidden
            className="bg-foreground absolute top-1.5 right-1.5 size-1.5 rounded-full"
          />
        ) : null}
      </Button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent data-report-sheet="filter">
          <DrawerTitle className="px-4 pt-4 text-sm font-medium">{t('title')}</DrawerTitle>
          <DrawerDescription className="sr-only">{t('description')}</DrawerDescription>
          {/* サイドバーと同じ横の余白（px-2）。行の高さはタッチ判定で 44px になる */}
          <div className="overflow-y-auto px-2 pt-2 pb-4">
            <ReportFilterList />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
