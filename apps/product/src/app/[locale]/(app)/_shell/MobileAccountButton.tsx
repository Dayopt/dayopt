'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { useLocale, useTranslations } from 'next-intl';

import { useAuthStore } from '@/features/auth';
import { getAvatarUrl, getDisplayName, getInitials } from '@/lib/user';
import { Avatar, AvatarFallback, AvatarImage, cn } from '@dayopt/components';
import { getPathname, usePathname } from '@dayopt/i18n/navigation';

function buildSettingsReturnPath(
  pathname: string,
  searchParams: { toString: () => string },
): string {
  const returnPathname = pathname || '/';
  const query = searchParams.toString();

  return query ? `${returnPathname}?${query}` : returnPathname;
}

interface MobileAccountButtonProps {
  href: string;
  displayName: string;
  avatarUrl?: string | null | undefined;
  ariaLabel: string;
  className?: string | undefined;
}

export function MobileAccountButton({
  href,
  displayName,
  avatarUrl,
  ariaLabel,
  className,
}: MobileAccountButtonProps) {
  return (
    <Link
      href={href}
      prefetch
      aria-label={ariaLabel}
      className={cn(
        'hover:bg-state-hover focus-visible:outline-ring flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-2',
        // 44px のタッチターゲットを擬似要素で確保する（`Button` の icon variant と同じ手口）。
        // 32px のままだと、隣に並ぶアイコンボタンだけが 44px でここだけ小さい
        // eslint-disable-next-line tailwindcss/no-arbitrary-value -- 擬似要素を描くには content が要り、空文字以外に書きようがない（packages/components の Button の icon variant と同じ記述）
        'relative after:absolute after:inset-0 after:m-auto after:size-11 after:content-[""]',
        className,
      )}
    >
      {/* **`size="sm"`（32px）にしない。** 箱と同寸になってアバターが縁まで埋まり、
          隣の 20px グリフと並ぶと不釣り合いに大きく、箱の hover も見えなくなる。
          24px なら内側に余白が残り、線のアイコンと光学的な重さが揃う（2026-09-07 実測）*/}
      <Avatar size="sm" className="size-6">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
        <AvatarFallback className="bg-muted text-muted-foreground text-xs">
          {getInitials(displayName)}
        </AvatarFallback>
      </Avatar>
    </Link>
  );
}

export function ConnectedMobileAccountButton({ className }: { className?: string | undefined }) {
  const t = useTranslations();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const locale = useLocale();
  const displayName = getDisplayName(user, 'User');
  const returnPath = buildSettingsReturnPath(pathname, searchParams);
  const href = getPathname({
    locale,
    href: {
      pathname: '/settings',
      query: { returnTo: returnPath },
    },
  });

  return (
    <MobileAccountButton
      href={href}
      displayName={displayName}
      avatarUrl={getAvatarUrl(user)}
      ariaLabel={t('navigation.navUser.account')}
      className={className}
    />
  );
}
