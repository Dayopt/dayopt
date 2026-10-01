import { Button, Logo } from '@dayopt/components';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface ErrorLayoutProps {
  code?: string;
  title: string;
  description: string;
  showBackButton?: boolean;
  backToHomeLabel?: string;
  contactLabel?: string;
  docsLabel?: string;
  children?: React.ReactNode;
}

export function ErrorLayout({
  code,
  title,
  description,
  showBackButton = true,
  backToHomeLabel = 'Back to home',
  contactLabel = 'Contact support',
  docsLabel = 'Documentation',
  children,
}: ErrorLayoutProps) {
  return (
    <div className="bg-background flex min-h-screen flex-col">
      <header className={design.errorHeader}>
        <Link href="/" className="inline-block">
          <Logo variant="lockup" size="lg" />
        </Link>
      </header>
      <main className={design.page}>
        <EditorialHeader eyebrow={code || 'Dayopt'} title={title} description={description} artwork>
          {children}
          {showBackButton && (
            <div className="mt-10">
              <Button asChild>
                <Link href="/">
                  <ArrowLeft className="mr-2 size-4" aria-hidden="true" />
                  {backToHomeLabel}
                </Link>
              </Button>
            </div>
          )}
        </EditorialHeader>
      </main>
      <footer className="border-border mt-auto border-t">
        <nav className={design.errorNavigation}>
          <Link href="/contact" className="hover:text-foreground">
            {contactLabel}
          </Link>
          <Link href="/docs" className="hover:text-foreground">
            {docsLabel}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
