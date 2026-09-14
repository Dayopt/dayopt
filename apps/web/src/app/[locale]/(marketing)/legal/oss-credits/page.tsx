import type { Locale } from '@dayopt/i18n/routing';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ISR: 法的ページは1日ごとに再検証
export const revalidate = 86400;

/**
 * OSSクレジット情報の型定義
 */
interface CreditInfo {
  name: string;
  version: string;
  license: string;
  repository?: string;
  publisher?: string;
  copyright?: string;
}

/**
 * メタデータ生成（SEO対策）
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'Open Source Licenses - Dayopt',
    description:
      'License information for open source software used in Dayopt. List of third-party dependencies and their licenses.',
  };
}

/**
 * OSSクレジットページ（Server Component）
 */
interface PageProps {
  params: Promise<{ locale?: Locale }>;
}

export default async function OSSCreditsPage({ params }: PageProps) {
  // localeパラメータを取得
  const { locale = 'ja' } = await params;

  // OSSクレジット情報を読み込み
  const creditsPath = join(process.cwd(), 'public/oss-credits.json');
  let credits: CreditInfo[] = [];
  let loadError = false;

  try {
    const creditsData = readFileSync(creditsPath, 'utf-8');
    credits = JSON.parse(creditsData) as CreditInfo[];
  } catch (error) {
    console.error('Failed to load OSS credits:', error);
    loadError = true;
  }

  // i18n翻訳取得
  const t = await getTranslations({ locale });

  // ライセンス統計を計算
  const licenseStats: Record<string, number> = {};
  credits.forEach((credit) => {
    licenseStats[credit.license] = (licenseStats[credit.license] || 0) + 1;
  });

  return (
    <div className="bg-background container mx-auto min-h-screen max-w-6xl px-4 py-12 md:px-8 md:py-16">
      {/* ヘッダー */}
      <div className="mb-8">
        <h1 className="mb-2 text-3xl font-medium">{t('ossCredits.title')}</h1>
        <p className="text-muted-foreground">{t('ossCredits.description')}</p>
      </div>

      {/* イントロダクション */}
      <div className="bg-container mb-8 rounded-2xl p-6">
        <p className="text-foreground mb-4">{t('ossCredits.intro')}</p>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">{t('ossCredits.totalPackages')}:</span>
          <span className="text-foreground text-xl font-medium">{credits.length}</span>
        </div>
      </div>

      {/* エラー表示 */}
      {loadError && (
        <div className="bg-muted text-destructive border-destructive mb-8 rounded-2xl border p-6">
          <p className="font-medium">{t('ossCredits.loadingError')}</p>
        </div>
      )}

      {/* ライセンス統計 */}
      {!loadError && (
        <div className="mb-8">
          <h2 className="mb-4 text-xl font-medium">{t('ossCredits.licenseDistribution')}</h2>
          <div className="bg-card border-border-subtle grid grid-cols-2 gap-4 rounded-2xl border p-6 shadow-sm md:grid-cols-4">
            {Object.entries(licenseStats)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 8)
              .map(([license, count]) => (
                <div key={license} className="text-center">
                  <div className="text-muted-foreground text-sm">{license}</div>
                  <div className="text-foreground text-2xl font-medium">{count}</div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* パッケージリスト */}
      {!loadError && (
        <div>
          <h2 className="mb-4 text-xl font-medium">
            {t('ossCredits.packageList', { count: credits.length })}
          </h2>
          <div className="space-y-4">
            {credits.map((credit) => (
              <div
                key={`${credit.name}-${credit.version}`}
                className="bg-card border-border-subtle hover:border-primary rounded-2xl border p-6 shadow-sm transition-colors"
              >
                <div className="mb-2 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <h3 className="text-foreground text-lg font-medium">
                    {credit.name}
                    <span className="text-muted-foreground ml-2 text-sm font-normal">
                      v{credit.version}
                    </span>
                  </h3>
                  <span className="bg-muted text-primary w-fit rounded-lg px-4 py-1 text-sm font-medium">
                    {credit.license}
                  </span>
                </div>

                <div className="text-muted-foreground space-y-1 text-sm">
                  {credit.publisher && (
                    <div>
                      <span className="font-medium">{t('ossCredits.publisher')}:</span>{' '}
                      {credit.publisher}
                    </div>
                  )}
                  {credit.repository && (
                    <div>
                      <span className="font-medium">{t('ossCredits.repository')}:</span>{' '}
                      <Link
                        href={credit.repository}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {credit.repository}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* フッター - 詳細情報へのリンク */}
      <div className="bg-container mt-12 rounded-2xl p-6 text-center">
        <p className="text-muted-foreground mb-4 text-sm">{t('ossCredits.footer.notice')}</p>
        <div className="flex flex-col gap-2 md:flex-row md:justify-center md:gap-4">
          <Link
            href="/THIRD_PARTY_NOTICES.txt"
            target="_blank"
            className="text-primary hover:underline"
          >
            {t('ossCredits.footer.thirdPartyNotices')}
          </Link>
        </div>
      </div>
    </div>
  );
}
