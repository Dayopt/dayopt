import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEstimationFactor } from '../../domain/activity-estimation-factor';

const queryResult = vi.hoisted(
  () =>
    ({ current: { data: undefined } }) as {
      current: { data: ActivityEstimationFactor[] | undefined };
    },
);

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}:${String(values?.duration ?? '')}`,
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    statistics: {
      getActivityEstimationFactors: {
        useQuery: () => queryResult.current,
      },
    },
  },
}));

const { EstimationFeedforward } = await import('./EstimationFeedforward');

beforeEach(() => {
  queryResult.current = {
    data: [{ activityId: 'activity-a', factor: 1.5, sampleCount: 4 }],
  };
});

describe('EstimationFeedforward', () => {
  it('Plan の作成・編集時に、係数を掛けた実時間を提示する', () => {
    render(<EstimationFeedforward destination="plan" activityId="activity-a" draftMinutes={30} />);

    // 1.5 * 30 = 45 分
    expect(screen.getByRole('status')).toHaveTextContent('recentActual:45m');
  });

  it('保存先が Record なら表示しない', () => {
    render(
      <EstimationFeedforward destination="record" activityId="activity-a" draftMinutes={30} />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('activity 未選択なら表示しない', () => {
    render(<EstimationFeedforward destination="plan" activityId={null} draftMinutes={30} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('係数を持たない activity では表示しない（n < 3 は server が返さない）', () => {
    render(
      <EstimationFeedforward destination="plan" activityId="activity-unknown" draftMinutes={30} />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('draft の長さが 0 なら表示しない', () => {
    render(<EstimationFeedforward destination="plan" activityId="activity-a" draftMinutes={0} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('draft の長さが負なら表示しない（start > end の不正入力中）', () => {
    render(<EstimationFeedforward destination="plan" activityId="activity-a" draftMinutes={-30} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('draft の長さが NaN なら表示しない（Invalid Date 由来）', () => {
    // `NaN <= 0` は false なので、`<= 0` だけのガードでは「NaN 分」を描画してしまう
    render(
      <EstimationFeedforward
        destination="plan"
        activityId="activity-a"
        draftMinutes={Number.NaN}
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('query が失敗しても ErrorState を出さず静かに消える', () => {
    // 失敗時は data が undefined。受動的なヒントなのでエラー表示はしない
    // （`test` skill の ErrorState 必須ルールに対する明示的な例外）
    queryResult.current = { data: undefined };

    render(<EstimationFeedforward destination="plan" activityId="activity-a" draftMinutes={30} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
