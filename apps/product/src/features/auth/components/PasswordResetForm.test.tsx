import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PasswordResetForm } from './PasswordResetForm';

const mockResetPassword = vi.fn();
const mockTurnstileMount = vi.fn();
let mockTurnstileEnabled = true;

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'ja' }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@dayopt/i18n/navigation', async () => {
  const React = await import('react');
  return {
    Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...props }, children),
  };
});

vi.mock('@/features/auth/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { resetPassword: typeof mockResetPassword }) => unknown) =>
    selector({ resetPassword: mockResetPassword }),
}));

// config だけ差し替え、到達不能判定を持つ useTurnstileGate は本物を通す。
vi.mock('@/lib/turnstile/config', () => ({
  isTurnstileEnabled: () => mockTurnstileEnabled,
  TURNSTILE_CONFIG: { SITE_KEY: 'test-site-key' },
}));

// Turnstile widget は onSuccess / onError を手で叩けるボタンに差し替える。
// 失敗後に widget が作り直される（key 変更で remount）ことを mount 回数で検証する。
vi.mock('@/lib/turnstile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/turnstile')>();
  const React = await import('react');
  const MockTurnstile = React.forwardRef(
    (
      {
        onSuccess,
        onError,
        onWidgetLoad,
      }: {
        onSuccess: (token: string) => void;
        onError: () => void;
        onWidgetLoad?: () => void;
      },
      _ref: React.Ref<unknown>,
    ) => {
      React.useEffect(() => {
        mockTurnstileMount();
        onWidgetLoad?.();
        // 実 widget と同じく mount 直後に 1 度だけ載ったことを通知する
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 時の 1 回だけでよい
      }, []);
      return React.createElement(React.Fragment, null, [
        React.createElement(
          'button',
          { type: 'button', key: 'ok', onClick: () => onSuccess('test-captcha-token') },
          'solve-captcha',
        ),
        React.createElement(
          'button',
          { type: 'button', key: 'ng', onClick: () => onError() },
          'break-captcha',
        ),
      ]);
    },
  );
  MockTurnstile.displayName = 'MockTurnstile';

  return {
    ...actual,
    Turnstile: MockTurnstile,
  };
});

describe('PasswordResetForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTurnstileEnabled = true;
    mockResetPassword.mockResolvedValue({ error: null });
  });

  it('captcha を解いてから送信すると captchaToken を渡す', async () => {
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'solve-captcha' }));
    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith('user@example.com', {
        captchaToken: 'test-captcha-token',
      });
    });
  });

  it('captcha が未解決なら送信ボタンを押せない（token 無しで /recover を叩かない）', async () => {
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');

    expect(screen.getByRole('button', { name: /sendResetLink/i })).toBeDisabled();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('captcha 失敗なら token を捨てて widget を作り直し、理由を出す', async () => {
    mockResetPassword.mockResolvedValue({
      error: { message: 'captcha protection: request disallowed', code: 'captcha_failed' },
    });
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'solve-captcha' }));
    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));

    await waitFor(() =>
      expect(screen.getByText(/auth\.errors\.captchaFailed/)).toBeInTheDocument(),
    );
    // widget が作り直される（初回 mount + 失敗後の remount で 2 回）
    expect(mockTurnstileMount).toHaveBeenCalledTimes(2);
    // single-use token を再利用しないよう、送信ボタンは再び disabled に戻る
    expect(screen.getByRole('button', { name: /sendResetLink/i })).toBeDisabled();
  });

  // 未登録アドレスは GoTrue が 200 を返し、登録済みアドレスは再送間隔で 429 になりうる。
  // 画面が分かれると、その差自体がアカウント存在の確認手段になる。
  it('再送間隔の 429 でも成功画面を出す（存在を漏らさない）', async () => {
    mockResetPassword.mockResolvedValue({
      error: {
        message: 'For security purposes, you can only request this after 47 seconds.',
        code: 'over_email_send_rate_limit',
      },
    });
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'solve-captcha' }));
    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));

    await waitFor(() =>
      expect(screen.getByText('auth.passwordResetForm.checkEmail')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/auth\.errors\./)).not.toBeInTheDocument();
  });

  it('成功時と同じ画面になる（未登録アドレスとの対称性）', async () => {
    mockResetPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'solve-captcha' }));
    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));

    await waitFor(() =>
      expect(screen.getByText('auth.passwordResetForm.checkEmail')).toBeInTheDocument(),
    );
  });

  // widget へ到達できない利用者を無言で締め出さない（送信は通し、サーバーの判断へ委ねる）
  it('captcha widget が error を返したら送信できるようになる', async () => {
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    expect(screen.getByRole('button', { name: /sendResetLink/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'break-captcha' }));

    expect(screen.getByRole('button', { name: /sendResetLink/i })).toBeEnabled();
    expect(screen.getByText('auth.errors.captchaUnavailable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));
    await waitFor(() => expect(mockResetPassword).toHaveBeenCalledWith('user@example.com'));
  });

  it('Turnstile 無効の環境では captchaToken を渡さず送信できる', async () => {
    mockTurnstileEnabled = false;
    const user = userEvent.setup();
    render(<PasswordResetForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /sendResetLink/i }));

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith('user@example.com');
    });
  });
});
