import { Link } from '@dayopt/i18n/navigation';
import type { NavigationItem, NavigationSection } from '@web/shell/navigation';

function GuideLinks({ items }: { items: NavigationItem[] }) {
  return (
    <>
      {items.map((item) => (
        <div key={item.href || item.title}>
          {item.href && (
            <Link className="flex min-h-12 items-center py-2 text-sm" href={item.href}>
              {item.title}
            </Link>
          )}
          {item.items && (
            <div className="pl-4">
              <GuideLinks items={item.items} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** キーボード・タッチ・JavaScript 無効時にも開けるガイド一覧。 */
export function GuideNavigation({
  navigation,
  label,
}: {
  navigation: NavigationSection[];
  label: string;
}) {
  return (
    <details data-docs-mobile-navigation>
      <summary className="cursor-pointer py-4 text-sm">{label}</summary>
      <nav className="grid gap-6 pb-6" aria-label={label}>
        {navigation.map((section) => (
          <div key={section.title}>
            <h2 className="text-muted-foreground mb-2 text-xs">{section.title}</h2>
            <GuideLinks items={section.items} />
          </div>
        ))}
      </nav>
    </details>
  );
}
