// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { WeekTrace } from './WeekTrace';

afterEach(cleanup);

it('lets a reader select a day while keeping the plan and record durations independent', () => {
  render(
    <WeekTrace
      copy={{
        label: '一週間の表示例',
        days: ['月', '火', '水', '木', '金', '土', '日'],
        plan: '予定',
        record: '記録',
        minuteUnit: '分',
        scale: '3時間',
      }}
    />,
  );
  const monday = screen.getByRole('radio', { name: /月:/ });
  const wednesday = screen.getByRole('radio', { name: /水: 予定 150 分, 記録 135 分/ });
  expect(monday).toHaveProperty('checked', true);
  expect(wednesday).toHaveProperty('checked', false);
  fireEvent.click(wednesday);
  expect(wednesday).toHaveProperty('checked', true);
  expect(monday).toHaveProperty('checked', false);
  const friday = screen.getByRole('radio', { name: /金:/ });
  expect(friday).toHaveProperty('checked', false);
  fireEvent.click(friday);
  expect(wednesday).toHaveProperty('checked', false);
  expect(friday).toHaveProperty('checked', true);
});
