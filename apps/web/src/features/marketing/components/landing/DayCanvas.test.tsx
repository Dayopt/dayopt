// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ja from '../../../../../messages/ja/marketing.json';
import { DayCanvas, type DayCanvasCopy } from './DayCanvas';

afterEach(cleanup);

describe('DayCanvas', () => {
  const copy = (ja.marketing.landing as Record<string, unknown>).experience as DayCanvasCopy;

  it('shows a 30 minute plan independently from the explicit record view', () => {
    const { container } = render(<DayCanvas copy={copy} />);
    fireEvent.click(screen.getByRole('button', { name: /30分の予定/ }));
    expect(
      container.querySelector('[data-plan-duration]')?.getAttribute('data-plan-duration'),
    ).toBe('30');
    expect(container.querySelector('[data-record-duration]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /45分の記録/ }));
    expect(
      container.querySelector('[data-plan-duration]')?.getAttribute('data-plan-duration'),
    ).toBe('30');
    expect(
      container.querySelector('[data-record-duration]')?.getAttribute('data-record-duration'),
    ).toBe('45');
  });

  it('puts 45 minutes into the next plan while identifying the record as previous-day data, and resets', () => {
    const { container } = render(<DayCanvas copy={copy} />);
    fireEvent.click(screen.getByRole('button', { name: /明日に45分/ }));
    expect(
      container.querySelector('[data-plan-duration]')?.getAttribute('data-plan-duration'),
    ).toBe('45');
    expect(container.querySelector('[data-record-day]')?.getAttribute('data-record-day')).toBe(
      'previous',
    );
    expect(screen.getByText(copy.previousRecord)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.reset }));
    expect(
      container.querySelector('[data-plan-duration]')?.getAttribute('data-plan-duration'),
    ).toBe('30');
    expect(container.querySelector('[data-record-day]')?.getAttribute('data-record-day')).toBe(
      'same',
    );
  });

  it('lets a reader explore the time axis, including the end-exclusive plan/record boundaries', () => {
    render(<DayCanvas copy={copy} />);
    const probe = screen.getByRole('slider', { name: copy.probeLabel });
    expect(probe.getAttribute('aria-valuetext')).toContain(copy.probeRecord);
    fireEvent.change(probe, { target: { value: '29' } });
    expect(probe.getAttribute('aria-valuetext')).toContain(copy.probeBoth);
    fireEvent.change(probe, { target: { value: '45' } });
    expect(probe.getAttribute('aria-valuetext')).toContain(copy.probeRoom);
    fireEvent.change(probe, { target: { value: '60' } });
    expect(probe.getAttribute('aria-valuetext')).toContain('10:00');
    fireEvent.click(screen.getByRole('button', { name: copy.reset }));
    expect(probe.getAttribute('aria-valuetext')).toContain('09:30');
  });
});
