import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffBadge } from './DiffBadge';

describe('DiffBadge', () => {
  it('差分が 0 なら表示しない', () => {
    const { container } = render(<DiffBadge diffMinutes={0} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('正の差分を上向き矢印と中立色で表示する', () => {
    const { container } = render(<DiffBadge diffMinutes={20} />);

    const badge = screen.getByText('+20min');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('text-muted-foreground');
    expect(badge).not.toHaveClass('text-success', 'text-destructive');
    expect(container.querySelector('svg.lucide-arrow-up')).toBeInTheDocument();
  });

  it('負の差分を下向き矢印と中立色で表示する', () => {
    const { container } = render(<DiffBadge diffMinutes={-15} />);

    const badge = screen.getByText('-15min');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('text-muted-foreground');
    expect(badge).not.toHaveClass('text-success', 'text-destructive');
    expect(container.querySelector('svg.lucide-arrow-down')).toBeInTheDocument();
  });
});
