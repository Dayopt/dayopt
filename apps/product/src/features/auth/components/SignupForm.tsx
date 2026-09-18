'use client';

import { useState } from 'react';

import { createDayoptUrl, dayoptUrls } from '@dayopt/config';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';

import { Link } from '@dayopt/i18n/navigation';
import { useForm } from 'react-hook-form';

import { logger } from '@/lib/logger';
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
  FieldSeparator,
  FieldSupportText,
  HoverTooltip,
  Input,
} from '@dayopt/components';
import { useAuthStore } from '../stores/useAuthStore';

import { resolveSchemaMessageKey } from '../lib/resolve-schema-message-key';
import { getAuthErrorKey } from '../lib/sanitize-auth-error';
import { signupSchema, type SignupFormData } from '../schemas/auth.schema';

/**
 * 漏洩パスワードチェック（オプショナル）
 * Have I Been Pwned APIが利用できない場合はfalseを返す
 */
async function safeCheckPasswordPwned(password: string): Promise<boolean> {
  try {
    // 動的インポートでエラーハンドリングを強化
    const { checkPasswordPwned } = await import('@/lib/auth/pwned-password');
    return await checkPasswordPwned(password);
  } catch (err) {
    logger.warn('[SignupForm] Pwned password check failed, skipping:', err);
    return false;
  }
}

/**
 * SignupForm - 堅牢なサインアップフォームコンポーネント
 *
 * 設計原則:
 * 1. 最小依存: メール・パスワードでのサインアップは外部サービスなしで動作
 * 2. グレースフルデグラデーション: Have I Been Pwned API等が失敗してもサインアップ可能
 * 3. クライアントサイドバリデーション: パスワード長
 */
export function SignupForm({ className, ...props }: React.ComponentProps<'div'>) {
  const params = useParams();
  const router = useRouter();
  const locale = (params?.locale as string) || 'ja';
  const t = useTranslations();
  const signUp = useAuthStore((state) => state.signUp);
  const signInWithOAuth = useAuthStore((state) => state.signInWithOAuth);

  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleOAuthSignup = async (provider: 'google') => {
    setServerError(null);
    try {
      const { error } = await signInWithOAuth(provider);
      if (error) {
        setServerError(t('auth.errors.unexpectedError'));
      }
    } catch (err) {
      logger.error(`[SignupForm] OAuth ${provider} error:`, err);
      setServerError(t('auth.errors.unexpectedError'));
    }
  };
  const [emailConfirmationPending, setEmailConfirmationPending] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const turnstile = useTurnstileGate();
  const turnstileLocale: 'ja' | 'en' | 'auto' =
    locale === 'ja' ? 'ja' : locale === 'en' ? 'en' : 'auto';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormData>({
    // monorepo (pnpm) で apps/product(zod3) と apps/web(zod4) を併存させているため、
    // @hookform/resolvers の zod adapter が strict 隔離下で型解決できない。
    // ランタイムは正常。zod version 統一は follow-up PR で対応する。
    resolver: zodResolver(signupSchema as never),
    defaultValues: {
      email: '',
      password: '',
    },
    mode: 'onSubmit', // DADS準拠: 送信時バリデーション
  });

  const onSubmit = async (data: SignupFormData) => {
    setServerError(null);

    // 漏洩パスワードチェック（オプショナル - Have I Been Pwned API）
    const isPwned = await safeCheckPasswordPwned(data.password);
    if (isPwned) {
      setServerError(t('auth.errors.pwnedPassword'));
      return;
    }

    try {
      const result = turnstile.token
        ? await signUp(data.email, data.password, { captchaToken: turnstile.token })
        : await signUp(data.email, data.password);
      if (result.error) {
        const errorKey = getAuthErrorKey(
          { message: result.error.message, code: result.error.code },
          'signup',
        );
        setServerError(t(errorKey));
        // Turnstile token は single-use / short-lived。失敗時は widget を reset して次の retry で
        // 新しい challenge token を取得させる（captcha 使い回しによる連続失敗を防ぐ）
        turnstile.reset();
      } else if (result.data.session) {
        // メール確認不要 — そのままアプリへ
        router.push(`/${locale}/calendar`);
      } else {
        // メール確認が必要 — 確認待ちUIを表示
        setPendingEmail(data.email);
        setEmailConfirmationPending(true);
      }
    } catch (err) {
      logger.error('[SignupForm] Signup error:', err);
      setServerError(t('auth.errors.unexpectedError'));
      turnstile.reset();
    }
  };

  if (emailConfirmationPending) {
    return (
      <div className={cn('flex flex-col gap-6', className)} {...props}>
        <Card className="overflow-hidden p-0">
          <CardContent className="flex flex-col items-center gap-4 p-6 text-center md:p-8">
            <div className="bg-muted flex size-10 items-center justify-center rounded-full">
              <Mail className="text-muted-foreground size-5" />
            </div>
            <h1 className="text-2xl font-medium">{t('auth.signupForm.checkEmail')}</h1>
            <p className="text-muted-foreground text-sm">
              {t('auth.signupForm.confirmationSent', { email: pendingEmail })}
            </p>
            <Link href="/auth/login" className="text-primary text-sm underline underline-offset-4">
              {t('auth.signupForm.backToLogin')}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          <form className="p-6 md:p-8" onSubmit={handleSubmit(onSubmit)}>
            <FieldGroup>
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-medium">{t('auth.signupForm.createAccount')}</h1>
              </div>

              {serverError && (
                <FieldError announceImmediately className="text-center">
                  {serverError}
                </FieldError>
              )}

              <Field>
                <Button
                  variant="outline"
                  type="button"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => handleOAuthSignup('google')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                    <path
                      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                      fill="currentColor"
                    />
                  </svg>
                  {t('auth.signupForm.signupWithGoogle')}
                </Button>
              </Field>

              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                {t('auth.signupForm.orContinueWith')}
              </FieldSeparator>

              <Field>
                <FieldLabel htmlFor="email" required requiredLabel={t('common.form.required')}>
                  {t('auth.signupForm.email')}
                </FieldLabel>
                <FieldSupportText id="email-support">
                  {t('auth.signupForm.emailSupportText')}
                </FieldSupportText>
                <Input
                  id="email"
                  type="email"
                  inputMode="email"
                  enterKeyHint="next"
                  aria-disabled={isSubmitting || undefined}
                  autoComplete="email"
                  aria-invalid={!!errors.email}
                  aria-describedby={
                    [errors.email ? 'email-error' : null, 'email-support']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  {...register('email')}
                />
                {errors.email?.message && (
                  <FieldError id="email-error">
                    {t(resolveSchemaMessageKey(errors.email.message))}
                  </FieldError>
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor="password" required requiredLabel={t('common.form.required')}>
                  {t('auth.signupForm.password')}
                </FieldLabel>
                <FieldSupportText id="password-support">
                  {t('auth.signupForm.passwordSupportText')}
                </FieldSupportText>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    enterKeyHint="go"
                    aria-disabled={isSubmitting || undefined}
                    autoComplete="new-password"
                    aria-invalid={!!errors.password}
                    aria-describedby={
                      [errors.password ? 'password-error' : null, 'password-support']
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    {...register('password')}
                  />
                  <HoverTooltip
                    content={
                      showPassword
                        ? t('auth.signupForm.hidePassword')
                        : t('auth.signupForm.showPassword')
                    }
                    side="top"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      icon
                      className="absolute top-0 right-0 h-full px-4"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-disabled={isSubmitting || undefined}
                      aria-label={
                        showPassword
                          ? t('auth.signupForm.hidePassword')
                          : t('auth.signupForm.showPassword')
                      }
                    >
                      {showPassword ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </Button>
                  </HoverTooltip>
                </div>
                {errors.password?.message && (
                  <FieldError id="password-error">
                    {t(resolveSchemaMessageKey(errors.password.message))}
                  </FieldError>
                )}
              </Field>

              {turnstile.enabled && (
                <Field>
                  <div className="flex justify-center">
                    <Turnstile
                      key={turnstile.widgetKey}
                      onWidgetLoad={turnstile.onWidgetLoad}
                      onSuccess={turnstile.onSuccess}
                      onError={turnstile.onError}
                      onExpire={turnstile.onExpire}
                      onUnsupported={turnstile.onUnsupported}
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
                  loading={isSubmitting}
                  disabled={turnstile.blocksSubmit}
                  className="w-full"
                >
                  {t('auth.signupForm.createAccountButton')}
                </Button>
                <p className="text-muted-foreground text-center text-xs leading-relaxed">
                  {t('auth.signupForm.byContinuing')}{' '}
                  <a
                    href={createDayoptUrl(dayoptUrls.marketing, '/legal/terms')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground underline underline-offset-4"
                  >
                    {t('auth.signupForm.termsOfService')}
                  </a>{' '}
                  {t('auth.signupForm.and')}{' '}
                  <a
                    href={createDayoptUrl(dayoptUrls.marketing, '/legal/privacy')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground underline underline-offset-4"
                  >
                    {t('auth.signupForm.privacyPolicy')}
                  </a>
                  {t('auth.signupForm.agree')}
                </p>
              </Field>

              <FieldDescription className="text-center">
                {t('auth.signupForm.alreadyHaveAccount')}{' '}
                <Link href="/auth/login">{t('auth.signupForm.login')}</Link>
              </FieldDescription>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
