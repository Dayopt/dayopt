// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { attempted, capture } = vi.hoisted(() => ({ attempted: vi.fn(), capture: vi.fn() }));
vi.mock('@web/components/errors/RootErrorState', () => {
  attempted();
  throw new Error('error view chunk failed');
});
vi.mock('@web/platform/observability/capture-boundary-error', () => ({
  captureBoundaryError: capture,
}));
vi.mock('@web/shell/layout/DocumentFrame', () => ({
  DocumentFrame: ({ children }: { children: React.ReactNode }) => children,
}));

import ErrorBoundary from './error';

afterEach(cleanup);

it('keeps retry and home available when the detailed error view cannot load', async () => {
  const reset = vi.fn();
  const error = new Error('original boundary failure');
  render(<ErrorBoundary error={error} reset={reset} />);
  await waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(capture).toHaveBeenCalledWith(error, 'root_error'));
  await waitFor(() =>
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'error view chunk failed' }),
      'root_error',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(reset).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: 'Go home' }).getAttribute('href')).toBe('/');
  expect(screen.queryByText('original boundary failure')).toBeNull();
});
