'use client';

import { useCallback, useRef, useState } from 'react';

import { Check, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';

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
  HoverTooltip,
  Input,
  Spinner,
} from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';

import { isMfaChallengeExpired, resolveMfaVerifyErrorKey } from '@/lib/auth/mfa-verify-error';
import { logger } from '@/lib/logger';
import { captureUnexpectedError, observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { vanillaTrpc } from '@/lib/trpc/client';
import { captureUnexpectedTrpcClientFailure } from '@/lib/trpc/client-errors';

import { resolveSchemaMessageKey } from '../lib/resolve-schema-message-key';
import { getAuthErrorKey } from '../lib/sanitize-auth-error';
import { passwordSchema } from '../schemas/auth.schema';
import { useAuthStore } from '../stores/useAuthStore';

// MFA(TOTP/リカバリーコード) step-up は MFA 有効アカウントの自己復旧経路でのみ表示される
// （mfaStepUp が true になった時だけ）。大多数の reset-password 訪問者には不要なため、
// 初回 First Load JS から切り離して bundle budget（#2121）の余地を確保する
const MFAVerifyForm = dynamic(
  () => import('./MFAVerifyForm').then((m) => ({ default: m.MFAVerifyForm })),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col items-center justify-center gap-6 p-6 md:p-8">
        <Spinner size="lg" />
      </div>
    ),
  },
);

type MfaVerifyMode = 'totp' | 'recovery';

/**
 * GoTrue が「本人確認が recovery session だけでは足りない」を示しているか。
 *
 * - `insufficient_aal`: アカウントに MFA(TOTP) が有効。recovery session は aal1 止まりで、
 *   GoTrue が config に関わらず更新を拒否する。#2013 で TOTP step-up / リカバリーコードに
 *   よる自己復旧を追加した（下記 startMfaStepUp 以降）
 * - `current_password_required` / `current_password_invalid`: recovery session でない
 *   セッション（通常ログイン中の直接アクセス等）でこの画面に来た。GoTrue ソース
 *   （`apierrors.ErrorCodeCurrentPasswordRequired` / `ErrorCodeCurrentPasswordMismatch`）で
 *   実際の文字列値を確認済み（後者は定数名に反し `current_password_invalid` を返す）
 * - `invalid_credentials`: `PasswordChangeDialog.tsx` の `isCurrentPasswordError` が同じ
 *   GoTrue 経路で観測している code。上と重複する可能性があるが、どちらが実際に返るかを
 *   確定できていないため両方を検知対象にする
 * - `reauthentication_needed`: production では現状発生しないが、設定 drift への保険
 *
 * 汎用の「時間をおいて再試行」に畳むと、再試行しても直らない状況で誤った案内になる。
 * 構造化 code を優先し、message の substring 判定は使わない（`PasswordChangeDialog.tsx`
 * の `isCurrentPasswordError` と同じ設計）。
 */
const RECOVERY_UPDATE_BLOCKED_CODES = new Set([
  'current_password_required',
  'current_password_invalid',
  'invalid_credentials',
  'reauthentication_needed',
]);

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

function isMfaBlocked(error: unknown): boolean {
  return errorCode(error) === 'insufficient_aal';
}

function isRecoverySessionInvalid(error: unknown): boolean {
  const code = errorCode(error);
  return typeof code === 'string' && RECOVERY_UPDATE_BLOCKED_CODES.has(code);
}

/**
 * 新しいパスワード設定フォーム。
 * recovery リンクは /auth/confirm の verifyOtp でセッション確立済みで着地する前提
 * （セッション無しの直接アクセスは page.tsx がサーバー側で弾く）
 */
export function ResetPasswordForm({ className, ...props }: React.ComponentProps<'div'>) {
  const router = useRouter();
  const params = useParams();
  const locale = (params?.locale as string) || 'ja';
  const t = useTranslations();
  const updatePassword = useAuthStore((state) => state.updatePassword);
  const supabase = createClient();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // MFA step-up state（#2013: MFA有効アカウントの自己復旧）。
  // recovery session は aal1 止まりのため、TOTP challenge/verify で aal2 へ昇格するか、
  // リカバリーコード（`user.verifyRecoveryCode`、成功時に factor を admin 権限で削除する
  // 既存副作用）でMFA自体を解除してから updatePassword を再試行する
  const [mfaStepUp, setMfaStepUp] = useState(false);
  const [mfaMode, setMfaMode] = useState<MfaVerifyMode>('totp');
  const [mfaVerificationCode, setMfaVerificationCode] = useState('');
  const [mfaRecoveryCode, setMfaRecoveryCode] = useState('');
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  // リカバリーコード経路は成功時にMFAを恒久無効化する（recovery-service.ts の既存副作用）。
  // 共有の汎用成功画面ではなく、その旨を明示する専用の警告を出す。
  // finishAfterStepUp の updatePassword が失敗してパスワード入力画面へ戻った後の
  // 再送信でも警告を正しく出すため、成功画面へ入る直前ではなくリカバリーコード検証
  // 成功時点で立てる。useState だと setMfaAlreadyDisabled(true) の直後に
  // finishAfterStepUp を呼ぶ際、同一 tick 内では再レンダーが挟まらず
  // enterSuccessState が古い closure の値を読んでしまうため useRef を使う
  const mfaAlreadyDisabledRef = useRef(false);
  const [mfaDisabledOnSuccess, setMfaDisabledOnSuccess] = useState(false);

  const startMfaStepUp = useCallback(async () => {
    setMfaStepUp(true);
    setMfaError(null);
    setMfaChallengeId(null);
    try {
      const { data: factors, error: factorsError } = await observeAuthOperation(
        'reset_password_mfa_list_factors',
        () => supabase.auth.mfa.listFactors(),
      );
      if (factorsError) {
        // 初期化自体ができない状態でMFA画面に留めても操作できない。password画面へ戻す
        // （insufficient_aalは変わらないので再送信は同じstartMfaStepUpへ再度入る=自然なretry）
        setMfaStepUp(false);
        setError(t('auth.errors.unexpectedError'));
        return;
      }

      const verifiedFactor = factors?.totp?.find((factor) => factor.status === 'verified');
      if (!verifiedFactor) {
        setMfaStepUp(false);
        setError(t('auth.errors.unexpectedError'));
        return;
      }
      setMfaFactorId(verifiedFactor.id);

      const { data: challengeData, error: challengeError } = await observeAuthOperation(
        'reset_password_mfa_challenge',
        () => supabase.auth.mfa.challenge({ factorId: verifiedFactor.id }),
      );
      if (challengeError || !challengeData) {
        setMfaStepUp(false);
        setError(t('auth.errors.unexpectedError'));
        return;
      }
      setMfaChallengeId(challengeData.id);
    } catch (err) {
      const original = err instanceof Error ? err : new Error('Reset password MFA init failed');
      captureUnexpectedError(original, { feature: 'auth', operation: 'reset_password_mfa_init' });
      setMfaStepUp(false);
      setError(t('auth.errors.unexpectedError'));
    }
  }, [supabase, t]);

  const enterSuccessState = useCallback(() => {
    setMfaDisabledOnSuccess(mfaAlreadyDisabledRef.current);
    setSuccess(true);
    setTimeout(() => {
      router.push(`/${locale}/auth/login`);
    }, 3000);
  }, [router, locale]);

  const finishAfterStepUp = useCallback(async () => {
    const { error: updateError } = await updatePassword(password);
    if (updateError) {
      // 昇格/リカバリー自体は成功したのに update が失敗した場合、MFA 検証はやり直せない
      // （TOTP challenge は使い切り、リカバリーコードは消費済み）。session は既に
      // 昇格済み/MFA解除済みのはずなので、password 入力画面へ戻して再送信すれば
      // MFA を経由せず updatePassword だけで成功する。MFA画面に留めて詰ませない
      setMfaStepUp(false);
      setError(
        t(
          getAuthErrorKey(
            { message: updateError.message, code: errorCode(updateError) },
            'updatePassword',
          ),
        ),
      );
      return;
    }
    enterSuccessState();
  }, [password, updatePassword, t, enterSuccessState]);

  const handleVerifyTotp = useCallback(async () => {
    if (!mfaFactorId || !mfaChallengeId || !mfaVerificationCode) {
      setMfaError(t('common.errors.mfa.enterCode'));
      return;
    }
    if (mfaVerificationCode.length !== 6) {
      setMfaError(t('common.errors.mfa.codeLength'));
      return;
    }

    setMfaVerifying(true);
    setMfaError(null);

    try {
      const { error: verifyError } = await observeAuthOperation('reset_password_mfa_verify', () =>
        supabase.auth.mfa.verify({
          factorId: mfaFactorId,
          challengeId: mfaChallengeId,
          code: mfaVerificationCode,
        }),
      );
      if (verifyError) {
        if (isMfaChallengeExpired(verifyError.code)) {
          // 初期化と同じ復帰経路を使い、再発行に失敗したらpassword入力へ戻す。
          await startMfaStepUp();
        }
        setMfaError(t(resolveMfaVerifyErrorKey(verifyError.code)));
        setMfaVerificationCode('');
        return;
      }
      await finishAfterStepUp();
    } catch {
      setMfaError(t('common.errors.mfa.verificationFailed'));
      setMfaVerificationCode('');
    } finally {
      setMfaVerifying(false);
    }
  }, [
    mfaFactorId,
    mfaChallengeId,
    mfaVerificationCode,
    supabase,
    finishAfterStepUp,
    startMfaStepUp,
    t,
  ]);

  const handleVerifyRecovery = useCallback(async () => {
    const trimmed = mfaRecoveryCode.trim().toUpperCase();
    if (!trimmed) {
      setMfaError(t('auth.mfaVerify.recoveryInvalid'));
      return;
    }

    setMfaVerifying(true);
    setMfaError(null);

    try {
      await vanillaTrpc.user.verifyRecoveryCode.mutate({ code: trimmed });
      // 検証成功時点でMFAは既に無効化されている（recovery-service.ts の既存副作用）。
      // 直後の updatePassword が失敗して password フォームへ戻っても、この事実は
      // 変わらないので finishAfterStepUp より前に確定させる
      mfaAlreadyDisabledRef.current = true;
      await finishAfterStepUp();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('RECOVERY_EXHAUSTED')) {
        setMfaError(t('auth.mfaVerify.recoveryExhausted'));
      } else if (message.includes('RECOVERY_INVALID')) {
        setMfaError(t('auth.mfaVerify.recoveryInvalid'));
      } else {
        const captured = captureUnexpectedTrpcClientFailure(err, {
          feature: 'auth',
          operation: 'reset_password_verify_recovery_code',
        });
        if (captured) logger.error('Reset password MFA recovery transport failed');
        setMfaError(t('common.errors.generic'));
      }
      setMfaRecoveryCode('');
    } finally {
      setMfaVerifying(false);
    }
  }, [mfaRecoveryCode, finishAfterStepUp, t]);

  const handleSwitchMfaMode = useCallback((newMode: MfaVerifyMode) => {
    setMfaMode(newMode);
    setMfaError(null);
    setMfaVerificationCode('');
    setMfaRecoveryCode('');
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError(null);

      if (password !== confirmPassword) {
        setError(t('auth.resetPasswordForm.passwordMismatch'));
        setLoading(false);
        return;
      }

      // signup / パスワード変更と同一のポリシー（8-64文字）を適用する
      const parsed = passwordSchema.safeParse(password);
      if (!parsed.success) {
        setError(t(resolveSchemaMessageKey(parsed.error.issues[0]?.message)));
        setLoading(false);
        return;
      }

      try {
        const { error } = await updatePassword(password);

        if (error) {
          if (isMfaBlocked(error)) {
            await startMfaStepUp();
          } else {
            const errorKey = isRecoverySessionInvalid(error)
              ? 'auth.errors.recoverySessionInvalid'
              : getAuthErrorKey(
                  { message: error.message, code: errorCode(error) },
                  'updatePassword',
                );
            setError(t(errorKey));
          }
        } else {
          enterSuccessState();
        }
      } catch {
        setError(t('auth.resetPasswordForm.updateError'));
      } finally {
        setLoading(false);
      }
    },
    [password, confirmPassword, updatePassword, t, startMfaStepUp, enterSuccessState],
  );

  if (success) {
    return (
      <div className={cn('flex flex-col gap-6', className)} {...props}>
        <Card className="overflow-hidden p-0">
          <CardContent className="p-0">
            <div className="p-6 md:p-8">
              <FieldGroup>
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="bg-state-active text-state-active-foreground mb-2 flex h-12 w-12 items-center justify-center rounded-full">
                    <Check className="h-6 w-6" />
                  </div>
                  <h1 className="text-2xl font-medium">
                    {t('auth.resetPasswordForm.successTitle')}
                  </h1>
                  <p className="text-muted-foreground text-balance">
                    {t('auth.resetPasswordForm.successMessage')}
                  </p>
                </div>
                {mfaDisabledOnSuccess && (
                  <div className="border-warning bg-warning-tint rounded-2xl p-4" role="alert">
                    <p className="text-warning text-base font-normal md:text-sm">
                      {t('auth.resetPasswordForm.mfaDisabledWarning')}
                    </p>
                  </div>
                )}
              </FieldGroup>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mfaStepUp) {
    return (
      <div className={cn('flex flex-col gap-6', className)} {...props}>
        <MFAVerifyForm
          mode={mfaMode}
          flow="passwordReset"
          verificationCode={mfaVerificationCode}
          onVerificationCodeChange={setMfaVerificationCode}
          recoveryCode={mfaRecoveryCode}
          onRecoveryCodeChange={setMfaRecoveryCode}
          isVerifying={mfaVerifying}
          error={mfaError}
          onVerifyTotp={handleVerifyTotp}
          onVerifyRecovery={handleVerifyRecovery}
          onSwitchMode={handleSwitchMfaMode}
          backHref={`/${locale}/auth/password`}
        />
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
                <h1 className="text-2xl font-medium">{t('auth.resetPasswordForm.title')}</h1>
                <p className="text-muted-foreground text-balance">
                  {t('auth.resetPasswordForm.description')}
                </p>
              </div>

              {error && (
                <FieldError announceImmediately className="text-center">
                  {error}
                </FieldError>
              )}

              <Field>
                <FieldLabel htmlFor="password">
                  {t('auth.resetPasswordForm.newPassword')}
                </FieldLabel>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-disabled={loading || undefined}
                    autoComplete="new-password"
                    required
                    minLength={8}
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
                      aria-disabled={loading || undefined}
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
              </Field>

              <Field>
                <FieldLabel htmlFor="confirmPassword">
                  {t('auth.resetPasswordForm.confirmPassword')}
                </FieldLabel>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    aria-disabled={loading || undefined}
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                  <HoverTooltip
                    content={
                      showConfirmPassword
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
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      aria-disabled={loading || undefined}
                      aria-label={
                        showConfirmPassword
                          ? t('auth.signupForm.hidePassword')
                          : t('auth.signupForm.showPassword')
                      }
                    >
                      {showConfirmPassword ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <EyeOff className="h-4 w-4" />
                      )}
                    </Button>
                  </HoverTooltip>
                </div>
              </Field>

              <Field>
                <Button
                  type="submit"
                  loading={loading}
                  loadingText={t('auth.resetPasswordForm.updating')}
                  className="w-full"
                >
                  {t('auth.resetPasswordForm.updateButton')}
                </Button>
              </Field>

              <FieldDescription className="text-center">
                <Link href="/auth/login">{t('auth.resetPasswordForm.backToLogin')}</Link>
              </FieldDescription>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
