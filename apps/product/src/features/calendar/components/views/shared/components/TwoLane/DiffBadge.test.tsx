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

    expect(screen.getByText('+20min')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-arrow-up')).toBeInTheDocument();
  });

  it('負の差分を下向き矢印と中立色で表示する', () => {
    const { container } = render(<DiffBadge diffMinutes={-15} />);

    expect(screen.getByText('-15min')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-arrow-down')).toBeInTheDocument();
  });
});
