import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANIMATED_WIDTH_PANEL_TRANSITION_MS, AnimatedWidthPanel } from './AnimatedWidthPanel';

describe('AnimatedWidthPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with the requested width', () => {
    render(
      <AnimatedWidthPanel open width={256} data-testid="panel">
        <div>content</div>
      </AnimatedWidthPanel>,
    );

    expect(screen.getByTestId('panel')).toHaveStyle({ width: '256px' });
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('keeps children mounted until the close animation finishes', () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <AnimatedWidthPanel open width={256} data-testid="panel">
        <div>content</div>
      </AnimatedWidthPanel>,
    );

    rerender(
      <AnimatedWidthPanel open={false} width={256} data-testid="panel">
        {null}
      </AnimatedWidthPanel>,
    );

    expect(screen.getByTestId('panel')).toHaveStyle({ width: '0px' });
    expect(screen.getByText('content')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(ANIMATED_WIDTH_PANEL_TRANSITION_MS);
    });

    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });
});
