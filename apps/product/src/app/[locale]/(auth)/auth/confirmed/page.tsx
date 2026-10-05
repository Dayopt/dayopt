/**
 * メール確認の結果ページ（#1956）
 *
 * `/auth/confirm` が token を検証したあと、**session を確立できなかった時**の着地先。
 *
 * ## なぜ login ページではなくこの専用ページか
 *
 * login に notice を出す案は、認証済みの browser で確認リンクを開いた場合に成立しない。
 * `proxy.ts` は認証済みユーザーが auth 系 path に来るとホームへ送り、`/auth/login` は
 * `authPathsAllowedWhileAuthenticated`（`lib/auth/domain/access-policy.ts`）に含まれない
 * ため、メッセージを表示する前に弾かれる。バウンス先が変わるだけで #1956 の混乱は残る。
 *
 * この path は同 allowlist に登録してあるので、**認証済み・未認証のどちらでも表示できる**。
 * 確認リンクはメールクライアントの browser でも、ログイン中の browser でも開かれるため、
 * 着地先が両方で成立することが要件になる。
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Link } from '@dayopt/i18n/navigation';

import { Button } from '@dayopt/components';

/** `/auth/confirm` が渡す結果コード。未知の値は汎用の失敗として扱う（fail closed）。 */
const CONFIRM_STATUSES = ['email_change_confirmed', 'email_confirmed', 'failed'] as const;

type ConfirmStatus = (typeof CONFIRM_STATUSES)[number];

function toConfirmStatus(value: string | string[] | undefined): ConfirmStatus {
  const status = Array.isArray(value) ? value[0] : value;
  return CONFIRM_STATUSES.includes(status as ConfirmStatus) ? (status as ConfirmStatus) : 'failed';
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.pageTitle');
  return { title: t('confirmed'), robots: { index: false, follow: false } };
}

export default async function EmailConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const status = toConfirmStatus((await searchParams).status);
  const t = await getTranslations('auth.confirmed');

  return (
    <div className="bg-surface-container flex min-h-svh flex-col items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-sm">
        <div
          className="bg-card border-border-subtle flex flex-col gap-6 rounded-2xl border p-6 shadow-sm"
          role="status"
          data-slot="confirm-result"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-medium">{t(`${status}.title`)}</h1>
            <p className="text-muted-foreground text-sm">{t(`${status}.body`)}</p>
          </div>

          <Button asChild className="w-full">
            <Link href="/auth/login">{t('goToLogin')}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
