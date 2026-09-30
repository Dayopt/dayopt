import { Logo } from '@dayopt/components';

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { ResetPasswordForm } from '@/features/auth';
import { createClient } from '@/lib/supabase/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.pageTitle');
  return { title: t('resetPassword') };
}

interface ResetPasswordPageProps {
  params: Promise<{ locale: string }>;
}

export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const { locale } = await params;

  // recovery リンクは /auth/confirm の verifyOtp でセッション確立済みの状態で着地する。
  // セッションが無い直接アクセスはサーバー側で即座にリダイレクトする
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/${locale}/auth`);
  }

  return (
    <div className="bg-surface-container flex min-h-svh flex-col items-center justify-center p-4 md:p-8">
      <Logo size="lg" className="mb-6" />
      <div className="w-full max-w-sm">
        <ResetPasswordForm />
      </div>
    </div>
  );
}
