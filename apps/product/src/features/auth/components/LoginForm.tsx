'use client';

import { useMemo, useRef, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { Link } from '@dayopt/i18n/navigation';
import { useForm } from 'react-hook-form';

import type { MessageKey } from '@/lib/i18n';
import { logger } from '@/lib/logger';
import { getSafeLocalizedRedirectPath, getSafeRedirectPath } from '@/lib/safe-redirect';
import { captureUnexpectedAuthError, observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { isTurnstileEnabled, Turnstile, type TurnstileInstance } from '@/lib/turnstile';
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
import { loginSchema, type LoginFormData } from '../schemas/auth.schema';

/**
 * LoginForm - 堅牢なログインフォームコンポーネント
 *
 * 設計原則:
 * 1. 最小依存: メール・パスワードでのログインは外部サービス（tRPC, reCAPTCHA）なしで動作
 * 2. グレースフルデグラデーション: DB/APIエラー時もフォーム表示・送信は可能
 * 3. オプショナル強化: ロックアウト・reCAPTCHA等は追加機能として後から有効化可能
 */
export function LoginForm({ className, ...props }: React.ComponentProps<'div'>) {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = (params?.locale as string) || 'ja';
  const t = useTranslations();
  const signIn = useAuthStore((state) => state.signIn);
  const signInWithOAuth = useAuthStore((state) => state.signInWithOAuth);
  const redirectPath = getSafeRedirectPath(searchParams?.get('redirect'));

  const handleOAuthLogin = async (provider: 'google') => {
    setSubmitError(null);
    try {
      const { error } = await signInWithOAuth(provider);
      if (error) {
        setSubmitError(t('auth.errors.unexpectedError'));
      }
    } catch (err) {
      logger.error(`[LoginForm] OAuth ${provider} error:`, err);
      setSubmitError(t('auth.errors.unexpectedError'));
    }
  };

  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const turnstileEnabled = isTurnstileEnabled();
  const turnstileLocale: 'ja' | 'en' | 'auto' =
    locale === 'ja' ? 'ja' : locale === 'en' ? 'en' : 'auto';

  // OAuth/メール確認 callback 失敗時、callback route が ?error= を付けて redirect する。
  // ユーザーに無言バウンスさせず、対応するメッセージを表示する。
  const queryError = useMemo(() => {
    const errorParam = searchParams?.get('error');
    if (!errorParam) return null;
    const errorKeyMap: Record<string, MessageKey> = {
      auth_callback_error: 'auth.errors.oauthCallbackError',
      auth_callback_missing_code: 'auth.errors.oauthCallbackMissingCode',
    };
    return t(errorKeyMap[errorParam] ?? 'auth.errors.unexpectedError');
  }, [searchParams, t]);

  const serverError = submitError ?? queryError;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    // monorepo (pnpm) で apps/product(zod3) と apps/web(zod4) を併存させているため、
    // @hookform/resolvers の zod adapter が strict 隔離下で型解決できない。
    // ランタイムは正常。zod version 統一は follow-up PR で対応する。
    resolver: zodResolver(loginSchema as never),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const onSubmit = async (data: LoginFormData) => {
    setSubmitError(null);

    try {
      // ステップ1: ログイン試行（最小依存で実行）
      const { error: signInError, data: signInData } = turnstileToken
        ? await signIn(data.email, data.password, { captchaToken: turnstileToken })
        : await signIn(data.email, data.password);

      if (signInError) {
        // ログイン失敗時: OWASP準拠でサニタイズ済みメッセージを表示
        const errorKey = getAuthErrorKey(
          { message: signInError.message, code: signInError.code },
          'login',
        );
        setSubmitError(t(errorKey));
        // Turnstile token は single-use / short-lived。失敗時は widget を reset して
        // 次の retry で新しい challenge token を取得させる
        setTurnstileToken(null);
        turnstileRef.current?.reset();
      } else if (signInData) {
        // ログイン成功

        // MFAチェック（セキュリティ上必須 - エラー時もMFA画面へ誘導）
        const supabase = createClient();
        const { data: aalData, error: mfaError } = await observeAuthOperation(
          'get_authenticator_assurance_level',
          () => supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        );

        // MFA検証画面へのリダイレクトURL構築
        // MFAVerifyPage は searchParams.get('next') でlocale付きパスを受け取る
        const fullRedirectPath = getSafeLocalizedRedirectPath(redirectPath, locale);
        const buildMfaUrl = () => {
          const base = `/${locale}/auth/mfa-verify`;
          return redirectPath !== '/calendar'
            ? `${base}?next=${encodeURIComponent(fullRedirectPath)}`
            : base;
        };

        // MFAが必要な場合、またはMFAチェックに失敗した場合
        // → MFA検証画面へ（エラー時にバイパスさせない）
        if (mfaError) {
          logger.warn(
            '[LoginForm] MFA check failed, redirecting to MFA verify for safety:',
            mfaError,
          );
          router.push(buildMfaUrl());
          return;
        }

        if (aalData?.currentLevel === 'aal1' && aalData?.nextLevel === 'aal2') {
          router.push(buildMfaUrl());
          return;
        }

        router.push(fullRedirectPath);
      }
    } catch (err) {
      logger.error('[LoginForm] Unexpected error:', err);
      captureUnexpectedAuthError(err, { operation: 'login_form' });
      setSubmitError(t('auth.errors.unexpectedError') || 'An unexpected error occurred');
      setTurnstileToken(null);
      turnstileRef.current?.reset();
    }
  };

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          {/* eslint-disable-next-line react-hooks/refs -- onSubmit は submit 時のみ turnstileRef.current を読む event handler。handleSubmit(onSubmit) の closure 解析による誤検知を抑制 */}
          <form className="p-6 md:p-8" onSubmit={handleSubmit(onSubmit)}>
            <FieldGroup>
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-medium">{t('auth.loginForm.welcomeBack')}</h1>
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
                  onClick={() => handleOAuthLogin('google')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                    <path
                      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                      fill="currentColor"
                    />
                  </svg>
                  {t('auth.loginForm.loginWithGoogle')}
                </Button>
              </Field>

              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                {t('auth.loginForm.orContinueWith')}
              </FieldSeparator>

              <Field>
                <FieldLabel htmlFor="email" required requiredLabel={t('common.form.required')}>
                  {t('auth.loginForm.email')}
                </FieldLabel>
                <FieldSupportText id="email-support">
                  {t('auth.loginForm.emailSupportText')}
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
                <div className="flex items-center">
                  <FieldLabel htmlFor="password" required requiredLabel={t('common.form.required')}>
                    {t('auth.loginForm.password')}
                  </FieldLabel>
                  <Link
                    href="/auth/password"
                    className="text-muted-foreground hover:text-foreground ml-auto text-sm underline underline-offset-4"
                  >
                    {t('auth.loginForm.forgotPassword')}
                  </Link>
                </div>
                <FieldSupportText id="password-support">
                  {t('auth.loginForm.passwordSupportText')}
                </FieldSupportText>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    enterKeyHint="go"
                    aria-disabled={isSubmitting || undefined}
                    autoComplete="current-password"
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
                        ? t('auth.loginForm.hidePassword')
                        : t('auth.loginForm.showPassword')
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
                          ? t('auth.loginForm.hidePassword')
                          : t('auth.loginForm.showPassword')
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

              {turnstileEnabled && (
                <Field>
                  <div className="flex justify-center">
                    <Turnstile
                      ref={turnstileRef}
                      onSuccess={(token) => setTurnstileToken(token)}
                      onError={() => setTurnstileToken(null)}
                      onExpire={() => setTurnstileToken(null)}
                      locale={turnstileLocale}
                    />
                  </div>
                </Field>
              )}

              <Field>
                <Button
                  type="submit"
                  loading={isSubmitting}
                  disabled={turnstileEnabled && !turnstileToken}
                  className="w-full"
                >
                  {t('auth.loginForm.loginButton')}
                </Button>
              </Field>

              <FieldDescription className="text-center">
                {t('auth.loginForm.noAccount')}{' '}
                <Link href="/auth/signup">{t('auth.loginForm.signUp')}</Link>
              </FieldDescription>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
