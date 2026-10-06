// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  radioChange: undefined as ((value: string) => void) | undefined,
  submitContactRequest: vi.fn(),
  tokenCounter: 0,
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@dayopt/components', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  RadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => {
    mocks.radioChange = onValueChange;
    return <div>{children}</div>;
  },
  RadioGroupItem: ({ id, value }: { id: string; value: string }) => (
    <input id={id} type="radio" value={value} onChange={() => mocks.radioChange?.(value)} />
  ),
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
vi.mock('@web/lib/turnstile', () => ({
  isTurnstileEnabled: () => true,
  Turnstile: ({ onSuccess }: { onSuccess: (token: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        mocks.tokenCounter += 1;
        onSuccess(`turnstile-token-${mocks.tokenCounter}`);
      }}
    >
      verify-turnstile
    </button>
  ),
}));
vi.mock('./contact-client', () => ({ submitContactRequest: mocks.submitContactRequest }));

import { ContactForm } from './contact-form';

function fillForm(message: string): void {
  fireEvent.change(document.querySelector<HTMLInputElement>('#name')!, {
    target: { value: 'Private Name' },
  });
  fireEvent.change(document.querySelector<HTMLInputElement>('#email')!, {
    target: { value: 'private@example.com' },
  });
  fireEvent.click(document.querySelector<HTMLInputElement>('#category-question')!);
  fireEvent.change(document.querySelector<HTMLTextAreaElement>('#message')!, {
    target: { value: message },
  });
}

describe('ContactForm retry contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.radioChange = undefined;
    mocks.tokenCounter = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('550e8400-e29b-41d4-a716-446655440000')
      .mockReturnValueOnce('650e8400-e29b-41d4-a716-446655440000');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses the translated required badge for every mandatory field', () => {
    render(<ContactForm />);
    expect(screen.getAllByText('form.requiredBadge')).toHaveLength(4);
    expect(screen.queryByText('※必須')).toBeNull();
  });

  it('retains fields, refreshes Turnstile, and reuses the submission ID after failure', async () => {
    mocks.submitContactRequest
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(undefined);

    render(<ContactForm />);
    fillForm('This is a private contact message.');
    fireEvent.click(screen.getByRole('button', { name: 'verify-turnstile' }));
    fireEvent.click(screen.getByRole('button', { name: 'form.submit' }));

    await waitFor(() => expect(mocks.submitContactRequest).toHaveBeenCalledTimes(1));
    await screen.findByRole('alert');

    expect(document.querySelector<HTMLInputElement>('#name')?.value).toBe('Private Name');
    expect(document.querySelector<HTMLInputElement>('#email')?.value).toBe('private@example.com');
    expect(document.querySelector<HTMLTextAreaElement>('#message')?.value).toBe(
      'This is a private contact message.',
    );
    expect(
      (screen.getByRole('button', { name: 'form.submit' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'verify-turnstile' }));
    fireEvent.click(screen.getByRole('button', { name: 'form.submit' }));

    await waitFor(() => expect(mocks.submitContactRequest).toHaveBeenCalledTimes(2));
    await screen.findByRole('status');

    const first = mocks.submitContactRequest.mock.calls[0]?.[0] as {
      submissionId: string;
      turnstileToken: string;
    };
    const retry = mocks.submitContactRequest.mock.calls[1]?.[0] as {
      submissionId: string;
      turnstileToken: string;
    };
    expect(first.submissionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(retry.submissionId).toBe(first.submissionId);
    expect(first.turnstileToken).toBe('turnstile-token-1');
    expect(retry.turnstileToken).toBe('turnstile-token-2');
  });

  it('uses a new submission ID after the normalized payload changes', async () => {
    mocks.submitContactRequest
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(undefined);

    render(<ContactForm />);
    fillForm('This is the first private contact message.');
    fireEvent.click(screen.getByRole('button', { name: 'verify-turnstile' }));
    fireEvent.click(screen.getByRole('button', { name: 'form.submit' }));

    await waitFor(() => expect(mocks.submitContactRequest).toHaveBeenCalledTimes(1));
    await screen.findByRole('alert');

    fireEvent.change(document.querySelector<HTMLTextAreaElement>('#message')!, {
      target: { value: 'This is the edited private contact message.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'verify-turnstile' }));
    fireEvent.click(screen.getByRole('button', { name: 'form.submit' }));

    await waitFor(() => expect(mocks.submitContactRequest).toHaveBeenCalledTimes(2));

    const first = mocks.submitContactRequest.mock.calls[0]?.[0] as { submissionId: string };
    const edited = mocks.submitContactRequest.mock.calls[1]?.[0] as { submissionId: string };
    expect(first.submissionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(edited.submissionId).toBe('650e8400-e29b-41d4-a716-446655440000');
  });
});
