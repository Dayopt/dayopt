/**
 * 認証状態の確認が一時的に失敗した時の着地ページ（#2144）
 *
 * `proxy.ts` の MFA AAL gate は `resolveMfaAssurance()` が `lookupFailed: true` を
 * 返すとこのページへ redirect する。以前は `/auth/login` へ送っていたが、
 * `/auth/login` は `authPathsAllowedWhileAuthenticated`（access-policy.ts）に
 * 含まれないため、認証済みユーザーが到達すると即座にホームへ弾き返され、
 * 保護されたカレンダーの MFA gate と無限 redirect ループになる可能性がある。
 *
 * この path は同 allowlist に登録してあるので、認証済みでも表示できる。
 * lookupFailed は user 状態が曖昧な時にも起きうるため、未認証でも表示できる
 * 必要がある（isProtectedProductPath の対象外なので認証は要求されない）。
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Link } from '@dayopt/i18n/navigation';

import { Button } from '@dayopt/components';

import { SignOutButton } from './_components/SignOutButton';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.pageTitle');
  return { title: t('sessionError'), robots: { index: false, follow: false } };
}

export default async function SessionErrorPage() {
  const t = await getTranslations('auth.sessionError');

  return (
    <div className="bg-surface-container flex min-h-svh flex-col items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-sm">
        <div
          className="bg-card border-border-subtle flex flex-col gap-6 rounded-2xl border p-6 shadow-sm"
          role="status"
          data-slot="session-error"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-medium">{t('title')}</h1>
            <p className="text-muted-foreground text-sm">{t('body')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link href="/">{t('retry')}</Link>
            </Button>
            <SignOutButton />
          </div>
        </div>
      </div>
    </div>
  );
}
