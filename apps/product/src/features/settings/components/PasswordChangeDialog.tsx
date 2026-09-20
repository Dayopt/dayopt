'use client';

import { useCallback, useState } from 'react';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { checkPasswordPwned } from '@/lib/auth/pwned-password';
import { logger } from '@/lib/logger';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@dayopt/components';

interface PasswordChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * GoTrue が「現在のパスワードが違う」を示しているか。
 *
 * 構造化された error code を第一候補にする。GoTrue の文言が変わっても判定が
 * 外れないため。code を持たない古いレスポンス向けに substring 判定を fallback
 * として残す（code が別値でも fallback は試す。判定漏れは生メッセージ露出では
 * なく汎用エラー表示に落ちるが、意味のある文言を優先したい）。
 */
function isCurrentPasswordError(error: unknown): boolean {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 'invalid_credentials') return true;

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('current_password') ||
    message.includes('current password') ||
    message.includes('invalid password') ||
    message.includes('incorrect password')
  );
}

/**
 * パスワード変更ダイアログ
 *
 * OWASP/NIST推奨のセキュリティチェックを含む
 */
export function PasswordChangeDialog({ open, onOpenChange }: PasswordChangeDialogProps) {
  const t = useTranslations();
  const supabase = createClient();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [signOutOthersFailed, setSignOutOthersFailed] = useState(false);

  const resetForm = useCallback(() => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setError(null);
    setSuccess(false);
    setSignOutOthersFailed(false);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onOpenChange(false);
  }, [onOpenChange, resetForm]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Validation
      if (newPassword !== confirmPassword) {
        setError(t('settings.account.passwordMismatch'));
        return;
      }
      if (newPassword.length < 8) {
        setError(t('settings.account.passwordMinLength'));
        return;
      }

      setError(null);
      setIsLoading(true);

      try {
        // Step 1: Pwned password check (NIST)
        const isPwned = await checkPasswordPwned(newPassword);
        if (isPwned) {
          throw new Error(t('settings.account.passwordPwned'));
        }

        // Step 2: Update password. 現在パスワードの検証はサーバー側が行う。
        // production の `security_update_password_require_current_password` が true のため、
        // `current_password` が一致しなければ GoTrue が拒否する（保証境界は
        // docs/product/specs/auth.md）。client 側で signInWithPassword による事前確認はしない
        // — 公開 Auth endpoint なので Bot Protection 有効時に CAPTCHA token を要求され、
        // 認証済みの設定画面から呼ぶと必ず失敗する（#1917）。
        const { error: updateError } = await observeAuthOperation('update_password', () =>
          supabase.auth.updateUser({
            password: newPassword,
            current_password: currentPassword,
          }),
        );

        if (updateError) {
          if (isCurrentPasswordError(updateError)) {
            throw new Error(t('settings.account.passwordIncorrect'));
          }
          // 生の英語メッセージを画面に出さない（i18n 破れと内部文言の露出を防ぐ）。
          // 原因の特定はログ側に残す。
          logger.error('Password update failed:', updateError);
          throw new Error(t('settings.account.passwordUpdateFailed'));
        }

        // Step 3: Sign out other sessions. パスワード更新（Step 2）は既に成功しているため、
        // ここで throw すると外側の catch に落ちて成功が失敗として表示されてしまう
        // （#1928 で useAuthStore.updatePassword に入れたのと同じ罠、#2015）。
        // ローカルで try/catch して握り潰し、1 回だけ再試行する。store と異なりこの
        // component は useTranslations を持つため、最終失敗は無言にせず success 画面に
        // 警告として表示する。
        let signOutSucceeded = false;
        for (let attempt = 0; attempt < 2 && !signOutSucceeded; attempt++) {
          try {
            const { error: signOutError } = await observeAuthOperation(
              'sign_out_other_sessions',
              () => supabase.auth.signOut({ scope: 'others' }),
            );
            signOutSucceeded = !signOutError;
          } catch {
            // observeAuthOperation は catch した例外を re-throw する契約なので、
            // ここで握り潰さないと外側の catch に落ちる。次の attempt へ。
          }
        }
        setSignOutOthersFailed(!signOutSucceeded);

        // 通知は、この updateUser が発火する Supabase Auth の
        // password_changed_notification を send-email hook が配送する（#2848）。
        setSuccess(true);
      } catch (err) {
        logger.error('Password update error:', err);
        const errorMessage =
          err instanceof Error ? err.message : t('settings.account.passwordUpdateFailed');
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, t, supabase],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.account.password')}</DialogTitle>
          <DialogDescription>
            {success ? t('settings.account.passwordUpdated') : t('settings.account.passwordDesc')}
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="space-y-4 py-4">
            <div className="border-success bg-success-tint rounded-2xl p-4">
              <p className="text-success text-base font-normal md:text-sm">
                {t('settings.account.passwordUpdated')}
              </p>
            </div>
            {signOutOthersFailed && (
              <div className="border-warning bg-warning-tint rounded-2xl p-4" role="alert">
                <p className="text-warning text-base font-normal md:text-sm">
                  {t('settings.account.signOutOthersFailed')}
                </p>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">{t('settings.account.currentPassword')}</Label>
                <div className="relative">
                  <Input
                    id="current-password"
                    type={showCurrentPassword ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={64}
                    autoComplete="current-password"
                    className="pr-8"
                    aria-invalid={!!error}
                    aria-describedby={error ? 'password-change-error' : undefined}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    aria-label={
                      showCurrentPassword
                        ? t('settings.account.hidePassword')
                        : t('settings.account.showPassword')
                    }
                  >
                    {showCurrentPassword ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="new-password">{t('settings.account.newPassword')}</Label>
                <div className="relative">
                  <Input
                    id="new-password"
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={64}
                    autoComplete="new-password"
                    className="pr-8"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    aria-label={
                      showNewPassword
                        ? t('settings.account.hidePassword')
                        : t('settings.account.showPassword')
                    }
                  >
                    {showNewPassword ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t('settings.account.passwordMinLength')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">{t('settings.account.confirmPassword')}</Label>
                <div className="relative">
                  <Input
                    id="confirm-password"
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={64}
                    autoComplete="new-password"
                    className="pr-8"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    aria-label={
                      showConfirmPassword
                        ? t('settings.account.hidePassword')
                        : t('settings.account.showPassword')
                    }
                  >
                    {showConfirmPassword ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {error && (
                <div
                  id="password-change-error"
                  role="alert"
                  className="border-destructive text-destructive rounded-lg border p-4 text-base md:text-sm"
                >
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose} disabled={isLoading}>
                {t('common.actions.cancel')}
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading
                  ? t('settings.account.updatingPassword')
                  : t('settings.account.updatePassword')}
              </Button>
            </DialogFooter>
          </form>
        )}

        {success && (
          <DialogFooter>
            <Button onClick={handleClose}>{t('common.actions.close')}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
