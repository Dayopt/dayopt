'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@dayopt/components';

import { SectionCard } from '@/components/ui/display/SectionCard';
import { type UseMFAReturn, useMFA } from '../../hooks/useMFA';
import { InfoBox } from '../InfoBox';

/** MFASection のプロップス定義 */
export interface MFASectionProps {
  /**
   * テスト・Storybook用フック差し替え。
   * 省略時は本物の useMFA を使用。
   * 本番コードでは渡さない。
   */
  _useMFAHook?: () => UseMFAReturn;
}

/**
 * MFA（多要素認証）セクション
 *
 * TOTP認証の登録・管理UIを提供
 */
export function MFASection({ _useMFAHook }: MFASectionProps = {}) {
  const t = useTranslations();
  // テスト用に差し替え可能。本番では常に useMFA を使う。
  const hookToUse = _useMFAHook ?? useMFA;
  const {
    hasMFA,
    showMFASetup,
    qrCode,
    secret,
    verificationCode,
    error,
    success,
    isLoading,
    recoveryCodes,
    recoveryCodeCount,
    showDisableDialog,
    showRegenerateDialog,
    setVerificationCode,
    enrollMFA,
    verifyMFA,
    requestDisableMFA,
    confirmDisableMFA,
    cancelDisableMFA,
    cancelSetup,
    requestRegenerateRecoveryCodes,
    confirmRegenerateRecoveryCodes,
    cancelRegenerateRecoveryCodes,
    dismissRecoveryCodes,
  } = hookToUse();

  // MFA無効化ダイアログ内のTOTPコード
  const [disableCode, setDisableCode] = useState('');

  const handleConfirmDisable = () => {
    confirmDisableMFA(disableCode);
    setDisableCode('');
  };

  const handleCancelDisable = () => {
    cancelDisableMFA();
    setDisableCode('');
  };

  return (
    <SectionCard title={t('settings.account.twoFactor')}>
      <div className="space-y-4">
        {/* エラー・成功メッセージ */}
        {error && (
          <div className="border-destructive text-destructive rounded-2xl border p-4 text-base md:text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="border-success text-success rounded-2xl border p-4 text-base md:text-sm">
            {success}
          </div>
        )}

        {/* リカバリーコード表示 */}
        {recoveryCodes && (
          <div className="border-warning space-y-4 rounded-2xl border p-4">
            <div>
              <h3 className="text-warning mb-2 text-lg font-medium">
                {t('settings.account.mfa.recoveryCodes.title')}
              </h3>
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.account.mfa.recoveryCodes.description')}
                <strong className="text-foreground">
                  {' '}
                  {t('settings.account.mfa.recoveryCodes.oneTimeUse')}
                </strong>
              </p>
            </div>

            <div className="bg-muted grid grid-cols-2 gap-2 rounded-2xl p-4 font-mono text-base md:text-sm">
              {recoveryCodes.map((code, index) => (
                <div key={index} className="text-foreground">
                  {code}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs">
                {t('settings.account.mfa.recoveryCodes.saveWarning')}
              </p>
              <Button variant="outline" onClick={dismissRecoveryCodes}>
                {t('settings.account.mfa.recoveryCodes.saved')}
              </Button>
            </div>
          </div>
        )}

        {/* MFA未設定時の表示 */}
        {!hasMFA && !showMFASetup && (
          <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-base font-normal">{t('settings.account.mfa.title')}</div>
              <p className="text-muted-foreground mt-1 text-base md:text-sm">
                {t('settings.account.mfa.description')}
              </p>
            </div>
            <Button type="button" onClick={enrollMFA} disabled={isLoading}>
              {isLoading ? t('settings.account.mfa.loading') : t('settings.account.mfa.enableMFA')}
            </Button>
          </div>
        )}

        {/* MFA設定中の表示 */}
        {!hasMFA && showMFASetup && qrCode && (
          <div className="bg-muted space-y-4 rounded-2xl p-6">
            <div>
              <h3 className="mb-2 text-lg font-medium">{t('settings.account.mfa.setup.title')}</h3>
              <p className="text-muted-foreground text-base md:text-sm">
                {t('settings.account.mfa.setup.description')}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <p className="mb-2 text-base font-normal md:text-sm">
                  {t('settings.account.mfa.setup.step1')}
                </p>
                {/* QRコードは白背景必須（読み取り精度のため） */}
                <div className="flex justify-center rounded-2xl bg-white p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- qrCode は動的生成の data URL。next/image の最適化対象外で利点がなく img で十分 */}
                  <img
                    src={qrCode}
                    alt={t('settings.account.mfa.setup.qrCodeAlt')}
                    className="h-48 w-48"
                  />
                </div>
                <p className="text-muted-foreground mt-2 text-xs">
                  {t('settings.account.mfa.setup.step1Desc')}
                </p>
              </div>

              {secret && (
                <div>
                  <p className="mb-2 text-base font-normal md:text-sm">
                    {t('settings.account.mfa.setup.manualEntry')}
                  </p>
                  <code className="bg-muted block rounded-lg p-2 text-xs">{secret}</code>
                </div>
              )}

              <div>
                <p className="mb-2 text-base font-normal md:text-sm">
                  {t('settings.account.mfa.setup.step2')}
                </p>
                <div className="flex items-center gap-4">
                  <InputOTP
                    maxLength={6}
                    value={verificationCode}
                    onChange={setVerificationCode}
                    aria-label={t('settings.account.mfa.setup.verificationCodeLabel')}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                  <Button onClick={verifyMFA} disabled={isLoading || verificationCode.length !== 6}>
                    {isLoading
                      ? t('settings.account.mfa.verifying')
                      : t('settings.account.mfa.verify')}
                  </Button>
                  <Button variant="ghost" onClick={cancelSetup}>
                    {t('settings.account.mfa.cancel')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MFA有効時の表示 */}
        {hasMFA && !recoveryCodes && (
          <div className="space-y-4">
            <div className="border-success rounded-2xl border p-4">
              <div className="mb-2 flex items-center gap-2">
                <div className="bg-success h-2 w-2 rounded-full"></div>
                <span className="text-success text-base font-normal md:text-sm">
                  {t('settings.account.mfa.enabled.title')}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('settings.account.mfa.enabled.description')}
              </p>
            </div>

            {/* リカバリーコード枯渇警告 */}
            {recoveryCodeCount === 0 && (
              <InfoBox variant="destructive">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-destructive text-base font-medium md:text-sm">
                    {t('settings.account.mfa.recoveryCodes.noCodesLeft')}
                  </span>
                </div>
                <p className="text-destructive text-xs">
                  {t('settings.account.mfa.recoveryCodes.exhaustedWarning')}
                </p>
                <div className="mt-4">
                  <Button
                    variant="destructive"
                    onClick={requestRegenerateRecoveryCodes}
                    disabled={isLoading}
                  >
                    {isLoading
                      ? t('settings.account.mfa.generating')
                      : t('settings.account.mfa.regenerate')}
                  </Button>
                </div>
              </InfoBox>
            )}

            {/* リカバリーコード状態（残りがある場合） */}
            {recoveryCodeCount > 0 && (
              <div className="bg-muted rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-normal md:text-sm">
                      {t('settings.account.mfa.recoveryCodes.sectionTitle')}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('settings.account.mfa.recoveryCodes.remaining', {
                        count: recoveryCodeCount,
                      })}
                    </p>
                  </div>
                  <Button onClick={requestRegenerateRecoveryCodes} disabled={isLoading}>
                    {isLoading
                      ? t('settings.account.mfa.generating')
                      : t('settings.account.mfa.regenerate')}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="destructive" onClick={requestDisableMFA} disabled={isLoading}>
                {isLoading
                  ? t('settings.account.mfa.processing')
                  : t('settings.account.mfa.disableMFA')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* MFA無効化ダイアログ */}
      <AlertDialog open={showDisableDialog} onOpenChange={(open) => !open && handleCancelDisable()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.account.mfa.disableDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.account.mfa.disableDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-center py-4">
            <InputOTP
              maxLength={6}
              value={disableCode}
              onChange={setDisableCode}
              onComplete={handleConfirmDisable}
              aria-label={t('settings.account.mfa.disableDialog.codeLabel')}
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDisable}>
              {t('settings.account.mfa.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                handleConfirmDisable();
              }}
              disabled={disableCode.length !== 6 || isLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive-hover"
            >
              {isLoading
                ? t('settings.account.mfa.processing')
                : t('settings.account.mfa.disableMFA')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* リカバリーコード再生成確認ダイアログ */}
      <AlertDialog
        open={showRegenerateDialog}
        onOpenChange={(open) => !open && cancelRegenerateRecoveryCodes()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.account.mfa.regenerateDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.account.mfa.regenerateDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelRegenerateRecoveryCodes}>
              {t('settings.account.mfa.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                confirmRegenerateRecoveryCodes();
              }}
            >
              {t('settings.account.mfa.regenerate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
