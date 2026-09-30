// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoundaryRecovery } from './BoundaryRecovery';
import { GlobalErrorPresentation } from './GlobalErrorPresentation';
import { RootErrorState } from './RootErrorState';

afterEach(cleanup);

for (const [name, View] of [
  ['loading recovery', BoundaryRecovery],
  ['root error', RootErrorState],
  ['global error', GlobalErrorPresentation],
] as const) {
  it(`${name} retries the current boundary without exposing the error in production`, () => {
    const onRetry = vi.fn();
    render(<View error={new Error('private error details')} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('private error details')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go home' }).getAttribute('href')).toBe('/');
  });
}

it('keeps the global error message and digest available only in development', () => {
  render(
    <GlobalErrorPresentation
      error={Object.assign(new Error('development detail'), { digest: 'dev-id' })}
      onRetry={vi.fn()}
      showDetails
    />,
  );
  expect(screen.getByText('development detail')).toBeTruthy();
  expect(screen.getByText('Error ID: dev-id')).toBeTruthy();
});
