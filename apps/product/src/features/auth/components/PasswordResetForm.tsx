'use client';

import { useState } from 'react';

import { useParams } from 'next/navigation';

import { Link } from '@dayopt/i18n/navigation';

import { Turnstile, useTurnstileGate } from '@/lib/turnstile';

import {
  Button,
  Card,
  CardContent,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSupportText,
  Input,
} from '@dayopt/components';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '../stores/useAuthStore';

import { getAuthErrorKey } from '../lib/sanitize-auth-error';

/** パスワードリセットメール送信フォーム。送信成功後は確認メッセージに切り替わる */
export function PasswordResetForm({ className, ...props }: React.ComponentProps<'div'>) {
  const t = useTranslations();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const resetPassword = useAuthStore((state) => state.resetPassword);
  const params = useParams();
  const locale = (params?.locale as string) || 'ja';
  const turnstile = useTurnstileGate();
  const turnstileLocale: 'ja' | 'en' | 'auto' =
    locale === 'ja' ? 'ja' : locale === 'en' ? 'en' : 'auto';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { error } = turnstile.token
        ? await resetPassword(email, { captchaToken: turnstile.token })
        : await resetPassword(email);

      // OWASP: 送信結果で画面を変えない。未登録アドレスは GoTrue が 200 を返す一方、
      // 登録済みアドレスは再送間隔（max_frequency）の 429 などで失敗しうる。エラーを
      // そのまま出すと「エラー画面が出る = 登録済み」という存在確認になる（spec
      // docs/product/specs/auth.md の列挙防止）。失敗の記録は store 側の Sentry が持つ。
      // 例外は captcha 失敗で、これは本人が解き直せば解決するので伝える。
      if (error?.code === 'captcha_failed') {
        setError(t(getAuthErrorKey({ message: error.message, code: error.code }, 'resetPassword')));
        // Turnstile token は single-use。失敗時は widget を reset して次の retry で
        // 新しい challenge token を取得させる
        turnstile.reset();
      } else {
        setSuccess(true);
      }
    } catch {
      setError(t('auth.errors.unexpectedError'));
      turnstile.reset();
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className={cn('flex flex-col gap-6', className)} {...props}>
        <Card className="overflow-hidden p-0">
          <CardContent className="p-0">
            <div className="p-6 md:p-8">
              <FieldGroup>
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="text-2xl font-medium">{t('auth.passwordResetForm.checkEmail')}</h1>
                  <p className="text-muted-foreground text-balance">
                    {t('auth.passwordResetForm.sentResetLink')}{' '}
                    <span className="font-normal">{email}</span>
                  </p>
                </div>
                <Field>
                  <Button asChild>
                    <Link href="/auth/login">{t('auth.passwordResetForm.backToLogin')}</Link>
                  </Button>
                </Field>
              </FieldGroup>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          <form className="p-6 md:p-8" onSubmit={handleSubmit}>
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-2xl font-medium">
                  {t('auth.passwordResetForm.resetPassword')}
                </h1>
                <p className="text-muted-foreground text-balance">
                  {t('auth.passwordResetForm.enterEmail')}
                </p>
              </div>
              {error && (
                <FieldError announceImmediately className="text-center">
                  {error}
                </FieldError>
              )}

              <Field>
                <FieldLabel htmlFor="email" required requiredLabel={t('common.form.required')}>
                  {t('auth.passwordResetForm.email')}
                </FieldLabel>
                <FieldSupportText id="email-support">
                  {t('auth.passwordResetForm.emailSupportText')}
                </FieldSupportText>
                <Input
                  id="email"
                  type="email"
                  inputMode="email"
                  enterKeyHint="send"
                  aria-disabled={loading || undefined}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  aria-describedby="email-support"
                />
              </Field>

              {turnstile.enabled && (
                <Field
                  /*
                   * `appearance: 'interaction-only'` の widget は普段 高さ 0 になるが、
                   * FieldGroup の `gap-6` は残るので空の段が空く。対話も到達不能の案内も
                   * 出ていない間だけ、その gap を打ち消す。
                   *
                   * 打ち消しに失敗しても widget は出たままで、前の Field と詰まって
                   * 見えるだけ。利用者が challenge を見られなくなる方向へは倒れない。
                   */
                  className={turnstile.interactive || turnstile.unavailable ? undefined : '-mt-6'}
                >
                  <div className="flex justify-center">
                    <Turnstile
                      key={turnstile.widgetKey}
                      onWidgetLoad={turnstile.onWidgetLoad}
                      onSuccess={turnstile.onSuccess}
                      onError={turnstile.onError}
                      onExpire={turnstile.onExpire}
                      onUnsupported={turnstile.onUnsupported}
                      onBeforeInteractive={turnstile.onBeforeInteractive}
                      locale={turnstileLocale}
                    />
                  </div>
                  {turnstile.unavailable && (
                    <FieldDescription data-slot="turnstile-unavailable">
                      {t('auth.errors.captchaUnavailable')}
                    </FieldDescription>
                  )}
                </Field>
              )}

              <Field>
                <Button
                  type="submit"
                  loading={loading}
                  loadingText={t('auth.passwordResetForm.sending')}
                  disabled={turnstile.blocksSubmit}
                >
                  {t('auth.passwordResetForm.sendResetLink')}
                </Button>
              </Field>
              <FieldDescription className="text-center">
                {t('auth.passwordResetForm.googleHint')}
              </FieldDescription>
              <FieldDescription className="text-center">
                {t('auth.passwordResetForm.rememberPassword')}{' '}
                <Link href="/auth/login">{t('auth.passwordResetForm.login')}</Link>
              </FieldDescription>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
