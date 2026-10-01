import { Logo } from '@dayopt/components';

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PasswordResetForm } from '@/features/auth';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.pageTitle');
  return { title: t('password') };
}

export default function PasswordResetPage() {
  return (
    <div className="bg-surface-container flex min-h-svh flex-col items-center justify-center p-4 md:p-8">
      <Logo size="lg" className="mb-6" />
      <div className="w-full max-w-sm">
        <PasswordResetForm />
      </div>
    </div>
  );
}
