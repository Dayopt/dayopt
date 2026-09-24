import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PasswordChangeDialog } from './PasswordChangeDialog';

const mockUpdateUser = vi.fn();
const mockSignInWithPassword = vi.fn();
const mockSignOut = vi.fn();
const mockCheckPasswordPwned = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/auth/pwned-password', () => ({
  checkPasswordPwned: (password: string) => mockCheckPasswordPwned(password),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
      updateUser: mockUpdateUser,
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<PasswordChangeDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe('PasswordChangeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPasswordPwned.mockResolvedValue(false);
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockUpdateUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockSignOut.mockResolvedValue({ error: null });
  });

  it('passes current_password to the server and never calls signInWithPassword', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('settings.account.currentPassword'), 'old-password');
    await user.type(screen.getByLabelText('settings.account.newPassword'), 'new-password-1');
    await user.type(screen.getByLabelText('settings.account.confirmPassword'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'settings.account.updatePassword' }));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({
        password: 'new-password-1',
        current_password: 'old-password',
      });
    });

    // #1917: 公開 Auth endpoint での再認証はしない（Bot Protection 有効時に必ず失敗するため）。
    // 現在パスワードの検証は production の security_update_password_require_current_password が
    // 有効な GoTrue 側が担う（docs/product/specs/auth.md）。
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('shows the current password error when Supabase rejects current_password', async () => {
    const user = userEvent.setup();
    mockUpdateUser.mockResolvedValue({
      data: { user: null },
      error: new Error('Current password is incorrect'),
    });

    renderDialog();

    await user.type(screen.getByLabelText('settings.account.currentPassword'), 'wrong-password');
    await user.type(screen.getByLabelText('settings.account.newPassword'), 'new-password-1');
    await user.type(screen.getByLabelText('settings.account.confirmPassword'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'settings.account.updatePassword' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('settings.account.passwordIncorrect');
    });

    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('does not mistake a captcha failure for a wrong current password', async () => {
    const user = userEvent.setup();
    mockUpdateUser.mockResolvedValue({
      data: { user: null },
      error: new Error('captcha protection: request disallowed (no captcha_token found)'),
    });

    renderDialog();

    await user.type(screen.getByLabelText('settings.account.currentPassword'), 'old-password');
    await user.type(screen.getByLabelText('settings.account.newPassword'), 'new-password-1');
    await user.type(screen.getByLabelText('settings.account.confirmPassword'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'settings.account.updatePassword' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // #1917: captcha 由来の失敗を「パスワードが正しくありません」に化けさせない。
    // あわせて GoTrue の生の英語メッセージを画面へ出さないことも固定する。
    expect(screen.getByRole('alert')).toHaveTextContent('settings.account.passwordUpdateFailed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('settings.account.passwordIncorrect');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('treats a structured invalid_credentials code as a wrong current password', async () => {
    const user = userEvent.setup();
    // GoTrue は理由を文言ではなく code で返す。文言が変わっても判定が外れないことを固定する。
    mockUpdateUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('Some future wording'), { code: 'invalid_credentials' }),
    });

    renderDialog();

    await user.type(screen.getByLabelText('settings.account.currentPassword'), 'wrong-password');
    await user.type(screen.getByLabelText('settings.account.newPassword'), 'new-password-1');
    await user.type(screen.getByLabelText('settings.account.confirmPassword'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'settings.account.updatePassword' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('settings.account.passwordIncorrect');
    });

    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
