// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { WeekTrace } from './WeekTrace';

afterEach(cleanup);

it('lets a reader select a day while keeping the plan and record durations independent', () => {
  const { container } = render(
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
  const wednesday = screen.getByRole('button', { name: /水:/ });
  fireEvent.click(wednesday);
  expect(wednesday.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('figcaption')?.textContent).toContain('150');
  expect(container.querySelector('figcaption')?.textContent).toContain('135');
  const friday = screen.getByRole('button', { name: /金:/ });
  fireEvent.click(friday);
  expect(wednesday.getAttribute('aria-pressed')).toBe('false');
  expect(friday.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('figcaption')?.textContent).toContain('180');
});
