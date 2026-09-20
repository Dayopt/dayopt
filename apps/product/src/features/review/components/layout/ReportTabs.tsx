'use client';

import { useTranslations } from 'next-intl';

import { IconTabSwitcher } from '@/components/ui/navigation/IconTabSwitcher';

import { reportTabs, type ReportTab } from '../../lib/report-tab';

interface ReportTabsProps {
  value: ReportTab;
  onValueChange: (tab: ReportTab) => void;
  className?: string | undefined;
}

/**
 * `/report` の面の切替（時間の使い方 / 差分 / 振り返り）。
 *
 * 見た目は共有の `IconTabSwitcher`（ワークスペース切替と粒度タブが使う帯）に揃える。
 * 同じ画面に 2 つのタブの見た目を混ぜない。
 *
 * 期間（週 / 月 / 年と `‹ ›`）はヘッダーに残し、タブとは独立した軸にする。
 * URL の書き換えは Composition Bridge が持つ（review は router を持たない）。
 */
export function ReportTabs({ value, onValueChange, className }: ReportTabsProps) {
  const t = useTranslations('report.tabs');

  return (
    <IconTabSwitcher
      ariaLabel={t('label')}
      value={value}
      onValueChange={onValueChange}
      className={className}
      items={reportTabs.map((tab) => ({ value: tab, label: t(tab) }))}
    />
  );
}
