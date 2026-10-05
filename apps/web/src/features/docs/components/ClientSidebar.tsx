'use client';

import { Link } from '@dayopt/i18n/navigation';
import { SearchDialog } from '@web/features/search';
import { type NavigationItem, type NavigationSection } from '@web/shell/navigation';
import { ExternalLink, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

interface NavigationItemProps {
  item: NavigationItem;
  level: number;
  currentPath: string;
}

function NavigationItemComponent({ item, level, currentPath }: NavigationItemProps) {
  const hasChildren = item.items && item.items.length > 0;
  const hasHref = Boolean(item.href);
  const paddingLeft = `${(level + 1) * 8}px`;
  // ロケールプレフィックス（/ja/, /en/）を除去してマッチング
  const normalizedPath = currentPath.replace(/^\/(ja|en)/, '');
  const isActive = item.href === normalizedPath || item.href === currentPath;

  return (
    <div>
      <div className="group flex items-center">
        {hasHref ? (
          <Link
            href={item.href!}
            className={`hover:bg-state-hover flex flex-1 items-center rounded-lg text-sm transition-colors ${
              isActive
                ? 'text-foreground bg-state-selected font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            style={{
              paddingLeft,
              paddingRight: '8px',
              paddingTop: '6px',
              paddingBottom: '6px',
            }}
          >
            <span className="flex-1">{item.title}</span>
            {item.badge && (
              <span className="bg-muted text-primary border-primary ml-2 rounded-lg border px-2 py-1 text-xs font-medium">
                {item.badge}
              </span>
            )}
            {item.external && <ExternalLink className="ml-1 size-3" />}
          </Link>
        ) : (
          <span
            className="text-foreground flex flex-1 items-center text-sm font-medium"
            style={{
              paddingLeft,
              paddingRight: '8px',
              paddingTop: '6px',
              paddingBottom: '6px',
            }}
          >
            <span className="flex-1">{item.title}</span>
          </span>
        )}
      </div>

      {hasChildren && (
        <div className="mt-1">
          {item.items!.map((child, index) => (
            <NavigationItemComponent
              key={child.href || `${item.title}-${index}`}
              item={child}
              level={level + 1}
              currentPath={currentPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ClientSidebarProps {
  navigation: NavigationSection[];
}

export function ClientSidebar({ navigation }: ClientSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations('common');
  const locale = useLocale();
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd+K / Ctrl+K で検索を開く
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Search（旧 docs ヘッダーから移設）— 入力は SearchDialog 側で受け付ける */}
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="border-input bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground mb-6 flex h-8 w-full items-center gap-2 rounded-lg border px-3 text-sm transition-colors"
      >
        <Search className="size-4 flex-shrink-0" />
        <span className="flex-1 text-left">{t('actions.search')}</span>
      </button>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} locale={locale} />

      {/* Navigation */}
      <nav className="flex-1 space-y-6">
        {navigation.map((section) => (
          <div key={section.title}>
            <div className="text-foreground cursor-default py-2 pr-4 pl-2 text-xs font-medium tracking-wider uppercase">
              {section.title}
            </div>

            <div className="mt-1 space-y-0">
              {section.items.map((item, index) => (
                <NavigationItemComponent
                  key={item.href || `${section.title}-${index}`}
                  item={item}
                  level={0}
                  currentPath={pathname}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}
