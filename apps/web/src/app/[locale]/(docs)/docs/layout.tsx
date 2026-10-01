import design from '@web/components/content/ContentDesign.module.css';
import { ClientSidebar, DocsMobileNavigation } from '@web/features/docs';
import { ContentTypography } from '@web/shell/layout/ContentTypography';
import { Footer } from '@web/shell/layout/Footer';
import { Header } from '@web/shell/layout/Header';
import { generateDocsNavigation } from '@web/shell/navigation';
import { setRequestLocale } from 'next-intl/server';

export default async function DocsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // 静的レンダリングを有効にする（これがないと配下が動的レンダリングになる）
  setRequestLocale(locale);
  const navigation = await generateDocsNavigation(locale);

  return (
    <ContentTypography className="bg-background flex min-h-screen flex-col">
      {/* 共通ヘッダー（marketing と統一、sticky） */}
      <Header />

      {/* 3カラムレイアウト: Sidebar(240px) | Main(flex-1)。Footer はこの外側で画面全幅にする */}
      <div className={design.docsShell}>
        {/* Left Sidebar - Navigation (lg以上で表示、sticky で独立スクロール) */}
        <aside className={design.docsSidebar} data-docs-desktop-navigation>
          <div>
            <ClientSidebar navigation={navigation} />
          </div>
        </aside>

        {/* Main Content */}
        <main id="main-content" role="main" className={design.docsContent}>
          <DocsMobileNavigation navigation={navigation} />
          {children}
        </main>
      </div>

      {/* Footer: Sidebar 部分も含めて画面全幅 */}
      <Footer />
    </ContentTypography>
  );
}
