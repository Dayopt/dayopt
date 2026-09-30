'use client';

import { Button, cn, Logo, Sheet, SheetContent } from '@dayopt/components';
import { productLoginUrl } from '@web/platform/config/product-signup-url';
import Link from 'next/link';
import type { HeaderLabels } from './HeaderClient';

export function HeaderMobileMenu({
  homeUrl,
  navigation,
  labels,
  open,
  isActive,
  onOpenChange,
  onCloseAutoFocus,
}: {
  homeUrl: string;
  navigation: Array<{ name: string; href: string; url: string }>;
  labels: HeaderLabels;
  open: boolean;
  isActive: (href: string) => boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        aria-label={labels.navigationMenu}
        closeButtonLabel={labels.closeMenu}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
        className="w-4/5 max-w-80 overflow-y-auto px-6 py-6 lg:hidden"
      >
        <Link
          href={homeUrl}
          prefetch={false}
          className="flex items-center gap-2"
          onClick={() => onOpenChange(false)}
        >
          <Logo variant="lockup" size="md" />
        </Link>

        <div className="mt-6 flow-root">
          <div className="divide-border -my-6 divide-y">
            <div className="space-y-1 py-6">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.url}
                  prefetch={false}
                  onClick={() => onOpenChange(false)}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'block rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                    isActive(item.href)
                      ? 'bg-state-selected text-foreground'
                      : 'text-foreground hover:bg-state-hover',
                  )}
                >
                  {item.name}
                </Link>
              ))}
            </div>

            <div className="py-6">
              <Button variant="outline" className="w-full" asChild>
                <a href={productLoginUrl()} onClick={() => onOpenChange(false)}>
                  {labels.login}
                </a>
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
