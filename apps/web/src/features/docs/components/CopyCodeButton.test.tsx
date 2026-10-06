// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    ({ copy: 'Copy', copied: 'Copied!' })[key as 'copy' | 'copied'],
}));
vi.mock('@dayopt/components', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { CopyCodeButton } from './CopyCodeButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('writes the exact code before showing copied feedback', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<CopyCodeButton code={'const answer = 42;\n'} />);
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByRole('button', { name: 'Copied!' });
  expect(writeText).toHaveBeenCalledExactlyOnceWith('const answer = 42;\n');
});

it('does not claim successful copying when clipboard access rejects', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<CopyCodeButton code="Example" />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('Example'));
  expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});
