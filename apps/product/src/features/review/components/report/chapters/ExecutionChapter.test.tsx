import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** 文言ではなく「どの値がどこへ出たか」を見たいので、翻訳は素通しにする。 */
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

import { ExecutionChapter } from './ExecutionChapter';

import type { ReportExecutionRow } from '../../../domain/report/report-view-model';

function row(overrides: Partial<ReportExecutionRow> = {}): ReportExecutionRow {
  return {
    activityId: 'act-write',
    name: '執筆',
    categoryName: '仕事',
    color: 'blue',
    archived: false,
    recordedMinutes: 600,
    plannedMinutes: 480,
    plannedPastMinutes: 480,
    recordedRatio: 1,
    plannedRatio: 0.8,
    planRatioPercent: 125,
    ...overrides,
  };
}

function rows() {
  return [...(document.querySelectorAll('[data-report-rows="execution"] > li') ?? [])];
}

describe('ExecutionChapter', () => {
  /** 仕様 §13-10。件数で切ると決算にならない。 */
  it('行を件数で切らずにすべて出す', () => {
    render(
      <ExecutionChapter
        granularity="week"
        mirrorRows={[]}
        rows={Array.from({ length: 24 }, (_, index) =>
          row({ activityId: `act-${index}`, name: `A${index}` }),
        )}
      />,
    );

    expect(rows()).toHaveLength(24);
  });

  it('過去予定が閾値以上の行にだけ予定比を出す', () => {
    render(
      <ExecutionChapter
        granularity="week"
        mirrorRows={[]}
        rows={[
          row({ activityId: 'ok', planRatioPercent: 125 }),
          row({ activityId: 'few', name: '運動', planRatioPercent: null }),
        ]}
      />,
    );

    expect(screen.getByText('report.execution.planRatio 125')).toBeInTheDocument();
    // 0% や空文字ではなくダッシュ。数えるに足りない回数で率を作らない
    expect(screen.getByText('report.execution.planRatioUnavailable')).toBeInTheDocument();
  });

  it('予定が無い行では破線バーを描かない', () => {
    render(
      <ExecutionChapter granularity="week" mirrorRows={[]} rows={[row({ plannedRatio: null })]} />,
    );

    expect(document.querySelector('.border-dashed')).toBeNull();
  });

  it('行に名前と記録時間の読み上げラベルが付く', () => {
    render(<ExecutionChapter granularity="week" mirrorRows={[]} rows={[row()]} />);

    expect(
      screen.getByRole('button', { name: 'report.execution.rowAriaLabel 執筆 10:00' }),
    ).toBeInTheDocument();
  });

  it('比較候補が無ければ説明を重ねず記録の行を残す', () => {
    render(<ExecutionChapter granularity="week" mirrorRows={[]} rows={[row()]} />);

    expect(screen.queryByText('report.execution.mirror.heading')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /report.execution.rowAriaLabel 執筆/ }),
    ).toBeInTheDocument();
  });

  it('記録も予定も無ければ空文言だけを出す', () => {
    render(<ExecutionChapter granularity="week" mirrorRows={[]} rows={[]} />);

    expect(screen.getByText('report.execution.empty.week')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });
});
