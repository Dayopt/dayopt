import { Button, Logo } from '@dayopt/components';
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
    <div className="bg-background grid min-h-screen grid-cols-1 grid-rows-[1fr_auto_1fr] lg:grid-cols-[max(50%,36rem)_1fr]">
      {/* Header */}
      <header className="mx-auto w-full max-w-7xl px-6 pt-6 sm:pt-12 lg:col-span-2 lg:col-start-1 lg:row-start-1 lg:px-8">
        <Link href="/" className="inline-block">
          <Logo variant="lockup" size="lg" />
        </Link>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl px-6 py-24 sm:py-32 lg:col-span-2 lg:col-start-1 lg:row-start-2 lg:px-8">
        <div className="max-w-lg">
          {code ? <p className="text-muted-foreground text-base font-medium">{code}</p> : null}
          <h1 className="text-foreground mt-4 text-5xl font-medium tracking-tight sm:text-6xl">
            {title}
          </h1>
          <p className="text-muted-foreground mt-6 text-lg font-medium sm:text-xl">{description}</p>

          {children}

          {showBackButton && (
            <div className="mt-12">
              <Button variant="ghost" size="sm" asChild>
                <Link
                  href="/"
                  className="text-foreground hover:text-muted-foreground inline-flex items-center gap-2 px-0"
                >
                  <ArrowLeft className="size-4" />
                  {backToHomeLabel}
                </Link>
              </Button>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="self-end lg:col-span-2 lg:col-start-1 lg:row-start-3">
        <div className="border-border bg-muted border-t py-12">
          <nav className="text-muted-foreground mx-auto flex w-full max-w-7xl items-center gap-x-4 px-6 text-sm lg:px-8">
            <Link href="/contact" className="hover:text-foreground">
              {contactLabel}
            </Link>
            <svg viewBox="0 0 2 2" aria-hidden="true" className="fill-border size-0.5">
              <circle r={1} cx={1} cy={1} />
            </svg>
            <Link href="/docs" className="hover:text-foreground">
              {docsLabel}
            </Link>
          </nav>
        </div>
      </footer>

      {/* Background Image */}
      <div className="hidden lg:relative lg:col-start-2 lg:row-start-1 lg:row-end-4 lg:block">
        <div className="from-muted to-background absolute inset-0 bg-gradient-to-br" />
        <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center opacity-10" />
      </div>
    </div>
  );
}
