'use client';

import { useCallback, useId, useState, type ReactNode } from 'react';

import { toast } from '@/lib/toast';
import { Camera, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { hasPasswordIdentity, useAuthStore } from '@/features/auth';
import { logger } from '@/lib/logger';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { getAvatarUrl, getDisplayName, getInitials } from '@/lib/user';
import { Avatar, AvatarFallback, AvatarImage, Button, Card } from '@dayopt/components';
import { useRouter } from '@dayopt/i18n/navigation';

import { LabeledRow } from '@/components/ui/display/LabeledRow';
import { AccountDeletionDialog } from './AccountDeletionDialog';
import { AvatarChangeDialog } from './AvatarChangeDialog';
import { DisplayNameDialog } from './DisplayNameDialog';
import { EmailChangeDialog } from './EmailChangeDialog';
import { PasswordChangeDialog } from './PasswordChangeDialog';
import { MFASection, type MFASectionProps } from './sections/MFASection';

/** AccountSettings のプロップス定義 */
interface AccountSettingsProps {
  /**
   * テスト・Storybook用 MFASection 差し替え。
   * 省略時は本物の MFASection を使用。
   * 本番コードでは渡さない。
   */
  _MFASectionProps?: MFASectionProps;
}

interface AccountSettingsGroupProps {
  title: string;
  children: ReactNode;
}

function AccountSettingsGroup({ title, children }: AccountSettingsGroupProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-muted-foreground px-1 text-xs font-medium">
        {title}
      </h2>
      <Card className="border-border-subtle gap-0 overflow-hidden rounded-lg py-0 shadow-sm">
        <div className="divide-border divide-y">{children}</div>
      </Card>
    </section>
  );
}

/**
 * アカウント設定コンポーネント
 *
 * プロフィール（アバター・表示名）、メール、パスワード、多要素認証、ログアウト、アカウント削除
 */
export function AccountSettings({ _MFASectionProps }: AccountSettingsProps = {}) {
  const t = useTranslations();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [showAvatarDialog, setShowAvatarDialog] = useState(false);
  const [showDisplayNameDialog, setShowDisplayNameDialog] = useState(false);

  const email = user?.email || '';
  // Google のみのユーザーはパスワードを持たない。パスワード前提の UI を出さない
  const canUsePassword = hasPasswordIdentity(user);
  const avatarUrl = getAvatarUrl(user);
  const displayName = getDisplayName(user);

  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true);
    try {
      const supabase = createClient();
      await observeAuthOperation('sign_out', () => supabase.auth.signOut());
      toast.success(t('navigation.navUser.logoutSuccess'));
      router.push('/auth/login');
      router.refresh();
    } catch (error) {
      logger.error('Logout error:', error);
      toast.error(t('navigation.navUser.logoutFailed'));
    } finally {
      setIsLoggingOut(false);
    }
  }, [t, router]);

  return (
    <div className="space-y-6 sm:space-y-8">
      <AccountSettingsGroup title={t('settings.account.profile')}>
        <div className="px-4">
          <LabeledRow
            label={t('settings.account.avatar')}
            variant="navigate"
            onClick={() => setShowAvatarDialog(true)}
          >
            <div className="group relative">
              <Avatar size="sm">
                <AvatarImage src={avatarUrl || undefined} alt={displayName} />
                <AvatarFallback className="bg-foreground text-background text-xs">
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="group-hover:bg-foreground absolute inset-0 flex items-center justify-center rounded-full transition-colors group-hover:opacity-40">
                <Camera className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </div>
          </LabeledRow>
        </div>

        <div className="px-4">
          <LabeledRow
            label={t('settings.account.displayName')}
            variant="navigate"
            onClick={() => setShowDisplayNameDialog(true)}
          >
            <span className="text-muted-foreground max-w-48 truncate text-sm sm:max-w-72">
              {displayName}
            </span>
          </LabeledRow>
        </div>

        <div className="px-4">
          {canUsePassword ? (
            <LabeledRow
              label={t('settings.account.email')}
              variant="navigate"
              onClick={() => setShowEmailDialog(true)}
            >
              <span className="text-muted-foreground max-w-48 truncate text-sm sm:max-w-72">
                {email || t('settings.account.noEmail')}
              </span>
            </LabeledRow>
          ) : (
            <LabeledRow
              label={t('settings.account.email')}
              description={t('settings.account.emailManagedByProvider')}
              variant="display"
            >
              <span className="text-muted-foreground max-w-48 truncate text-sm sm:max-w-72">
                {email || t('settings.account.noEmail')}
              </span>
            </LabeledRow>
          )}
        </div>
      </AccountSettingsGroup>

      <AccountSettingsGroup title={t('settings.account.sections.security')}>
        {!canUsePassword && (
          <div className="px-4">
            <LabeledRow
              label={
                <span className="flex items-center gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    className="size-4"
                    aria-hidden="true"
                  >
                    <path
                      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                      fill="currentColor"
                    />
                  </svg>
                  {t('settings.account.loginMethod.google')}
                </span>
              }
              variant="display"
            />
          </div>
        )}

        {canUsePassword && (
          <div className="px-4">
            <LabeledRow
              label={t('settings.account.password')}
              variant="navigate"
              onClick={() => setShowPasswordDialog(true)}
            >
              <span className="text-muted-foreground text-sm">••••••••</span>
            </LabeledRow>
          </div>
        )}

        <div className="px-4 py-4">
          <MFASection {..._MFASectionProps} embedded />
        </div>
      </AccountSettingsGroup>

      <AccountSettingsGroup title={t('settings.account.session')}>
        <div className="px-4">
          <LabeledRow label={t('navigation.navUser.logout')}>
            <Button variant="outline" onClick={handleLogout} disabled={isLoggingOut}>
              <LogOut className="mr-2 h-4 w-4" />
              {isLoggingOut ? t('navigation.navUser.loggingOut') : t('navigation.navUser.logout')}
            </Button>
          </LabeledRow>
        </div>
      </AccountSettingsGroup>

      <AccountSettingsGroup title={t('settings.account.dangerZone')}>
        <div className="p-4">
          <AccountDeletionDialog />
        </div>
      </AccountSettingsGroup>

      {/* Dialogs */}
      <AvatarChangeDialog open={showAvatarDialog} onOpenChange={setShowAvatarDialog} />
      <DisplayNameDialog
        open={showDisplayNameDialog}
        onOpenChange={setShowDisplayNameDialog}
        currentName={displayName}
      />
      <EmailChangeDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        currentEmail={email}
      />
      <PasswordChangeDialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog} />
    </div>
  );
}
