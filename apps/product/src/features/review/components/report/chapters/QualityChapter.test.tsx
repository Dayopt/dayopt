import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const translate = (key: string, values?: Record<string, unknown>) => {
      const base = namespace ? `${namespace}.${key}` : key;
      return values ? `${base} ${Object.values(values).join(' ')}` : base;
    };
    translate.raw = () => [];
    return translate;
  },
}));

import { QualityChapter } from './QualityChapter';

import type { ReportCompassPoint } from '../../../domain/report/report-view-model';

function point(overrides: Partial<ReportCompassPoint> = {}): ReportCompassPoint {
  return {
    activityId: 'act-write',
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    x: 50,
    y: 50,
    opacity: 0.87,
    answerCount: 4,
    recordedMinutes: 300,
    ...overrides,
  };
}

describe('QualityChapter', () => {
  /** 仕様 §13-6。充実に 1 件も回答が無くても落ちない。 */
  it('点が 0 件でもエラーにならず空文言を出す', () => {
    render(<QualityChapter points={[]} waitingActivities={[]} />);

    expect(screen.getByText('report.quality.emptyBoard 5')).toBeInTheDocument();
    expect(document.querySelector('[data-report-list="waiting"]')).toBeNull();
    expect(document.querySelector('[data-report-board="compass"]')).toBeNull();
    expect(screen.queryByText('report.quality.footnote 5')).not.toBeInTheDocument();
  });

  it('分布がある時は待機中のアクティビティも名前だけ並べる', () => {
    render(
      <QualityChapter
        points={[point()]}
        waitingActivities={[
          { activityId: 'a', name: '運動' },
          { activityId: 'b', name: '家事' },
        ]}
      />,
    );

    // 区切りも翻訳キー。素通しのモックではキー名がそのまま挟まる
    expect(
      screen.getByText('report.quality.waiting 運動report.quality.waitingSeparator家事'),
    ).toBeInTheDocument();
  });

  it('濃度の意味と点が生まれる回数を常に添える', () => {
    render(<QualityChapter points={[point()]} waitingActivities={[]} />);

    expect(screen.getByText('report.quality.footnote 5')).toBeInTheDocument();
  });

  it('点に名前と記録時間の読み上げラベルが付く', () => {
    render(<QualityChapter points={[point()]} waitingActivities={[]} />);

    expect(
      screen.getByRole('button', { name: 'report.quality.pointAriaLabel 執筆 5:00' }),
    ).toBeInTheDocument();
  });

  it('濃度は domain の値をそのまま使う（component で再計算しない）', () => {
    render(<QualityChapter points={[point({ opacity: 0.61 })]} waitingActivities={[]} />);

    const dot = document.querySelector('[data-report-board="compass"] button > span');
    expect((dot as HTMLElement).style.opacity).toBe('0.61');
  });

  /** 仕様 §13-14。右端の点はラベルを左へ倒し、320px 幅でも盤からはみ出さない。 */
  it('右端の点はラベルを左寄せへ倒す', () => {
    render(
      <QualityChapter
        points={[point({ activityId: 'right', x: 92 }), point({ activityId: 'left', x: 20 })]}
        waitingActivities={[]}
      />,
    );

    const labels = [...document.querySelectorAll('[data-report-board="compass"] button')].map(
      (button) => button.lastElementChild?.className ?? '',
    );
    expect(labels[0]).toContain('right-1/2');
    expect(labels[1]).toContain('left-1/2');
  });
});
