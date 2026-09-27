import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: (namespace?: string) => {
    const translate = (key: string, values?: Record<string, unknown>) => {
      const base = namespace ? `${namespace}.${key}` : key;
      return values ? `${base} ${Object.values(values).join(' ')}` : base;
    };
    return translate;
  },
}));

import { ReportHeader } from './ReportHeader';

const BASE_PROPS = {
  periodStart: new Date(2026, 7, 31),
  periodEnd: new Date(2026, 8, 6),
  granularity: 'week' as const,
  weekStartsOn: 1 as const,
  onNavigate: () => {},
  onGranularityChange: () => {},
};

/** `AppHeader` の 3 カラムグリッド（左 / 中央 / 右）のうち、要素が属する列を返す。 */
function columnOf(element: HTMLElement): Element | null {
  const grid = element.closest('header')?.querySelector(':scope > div');
  if (!grid) return null;
  return [...grid.children].find((column) => column.contains(element)) ?? null;
}

describe('ReportHeader', () => {
  /**
   * 粒度切替はカレンダーと同じく中央グループへ置く（2026-09-07 User 指示）。
   * `rightSlot` へ戻すと、期間ラベル・`‹ ›` と離れて画面の反対側へ飛ぶ。
   */
  it('粒度切替を期間ナビと同じ列に置く', () => {
    render(<ReportHeader {...BASE_PROPS} />);

    const granularity = screen.getByRole('button', { name: 'report.granularity.week' });
    const previous = screen.getByRole('button', { name: 'common.previous' });

    const granularityColumn = columnOf(granularity);
    expect(granularityColumn).not.toBeNull();
    expect(granularityColumn).toBe(columnOf(previous));
  });

  it('注入された rightSlot は右列に残す', () => {
    render(
      <ReportHeader
        {...BASE_PROPS}
        rightSlot={<button type="button">アカウント</button>}
        leftSlot={<button type="button">サイドバー</button>}
      />,
    );

    const injected = screen.getByRole('button', { name: 'アカウント' });
    const granularity = screen.getByRole('button', { name: 'report.granularity.week' });
    const sidebarToggle = screen.getByRole('button', { name: 'サイドバー' });

    expect(columnOf(injected)).not.toBe(columnOf(granularity));
    expect(columnOf(sidebarToggle)).not.toBe(columnOf(granularity));
    expect(columnOf(injected)).not.toBe(columnOf(sidebarToggle));
  });
});
