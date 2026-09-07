import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MobileWeekLaneSwitcher } from './MobileWeekLaneSwitcher';

describe('MobileWeekLaneSwitcher', () => {
  it('現在の表示対象をaria-pressedで示す', () => {
    render(<MobileWeekLaneSwitcher value="recorded" onValueChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'calendar.timeblock.preview.plan' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(
      screen.getByRole('button', { name: 'calendar.timeblock.preview.record' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('予定を選ぶとplannedへの変更を通知する', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<MobileWeekLaneSwitcher value="recorded" onValueChange={onValueChange} />);

    await user.click(screen.getByRole('button', { name: 'calendar.timeblock.preview.plan' }));

    expect(onValueChange).toHaveBeenCalledWith('planned');
  });
});
