'use client';

import { Button, cn, Logo, Sheet, SheetContent } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { useTranslations } from 'next-intl';

export function HeaderMobileMenu({
  navigation,
  open,
  isActive,
  onOpenChange,
  onCloseAutoFocus,
}: {
  navigation: Array<{ name: string; href: string }>;
  open: boolean;
  isActive: (href: string) => boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: () => void;
}) {
  const t = useTranslations('common');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        aria-label={t('aria.navigationMenu')}
        closeButtonLabel={t('aria.closeMenu')}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
        className="w-4/5 max-w-80 overflow-y-auto px-6 py-6 lg:hidden"
      >
        <Link href="/" className="flex items-center gap-2" onClick={() => onOpenChange(false)}>
          <Logo variant="lockup" size="md" />
        </Link>

        <div className="mt-6 flow-root">
          <div className="divide-border -my-6 divide-y">
            <div className="space-y-1 py-6">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
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
                <Link href="/login" onClick={() => onOpenChange(false)}>
                  {t('actions.login')}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
