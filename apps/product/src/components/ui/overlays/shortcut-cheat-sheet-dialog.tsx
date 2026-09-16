'use client';

import { useMemo, useState } from 'react';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useHasMounted } from '@/lib/hooks/useHasMounted';
import type { ScopedMessageKey } from '@/lib/i18n';
import type { ShortcutCatalog, ShortcutCatalogGroup } from '@/lib/keyboard/shortcut-catalog';
import { formatShortcutKey, type ShortcutPlatform } from '@/lib/keyboard/shortcut-key-label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, Input } from '@dayopt/components';

interface ShortcutCheatSheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: ShortcutCatalog;
  /**
   * 今開いているページのショートカットscope（例: 'calendar' | 'global'）。
   * このdialogは自身では現在ページを判定しない（componentsからfeaturesを
   * importすると依存方向違反になるため）。呼び出し側のComposition Layerが
   * 判定して渡す。
   */
  activeScope: string;
  platform?: ShortcutPlatform;
}

function detectShortcutPlatform(): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'mac' : 'other';
}

/**
 * groupの今開いているページとの関連度。
 *
 * 0 = このページ専用のgroup（最優先で先頭に表示）
 * 1 = globalスコープ（常にどのページでも有効。専用groupの次に表示）
 * 2 = 他ページ専用のgroup（現在は使えない。淡色表示 + 但し書き）
 *
 * globalスコープを「常に有効」として rank 0 と同列に扱わないのは、calendar画面で
 * 開いた時に calendar 専用の group（navigation/views/blocks）を general より
 * 先に出すため（設計書 §5）。
 */
function getShortcutScopeRank(group: ShortcutCatalogGroup, activeScope: string): 0 | 1 | 2 {
  if (group.scope === activeScope) return 0;
  if (group.scope === 'global') return 1;
  return 2;
}

/**
 * 「他ページ専用」group の但し書き（例: 'Available on the calendar screen'）。
 *
 * `ShortcutCatalogGroup.scope` はカタログ合成側の都合で closed union にしていない
 * （新しい catalog が任意の scope 文字列を宣言できる設計、shortcut-catalog.ts 参照）。
 * そのため `scopeHint.${scope}` の存在は静的に証明できず、`t.has()` で実在確認して
 * から翻訳する（存在しない scope は但し書きを出さないだけで、生キーは表示しない）。
 */
function scopeHint(
  tShortcuts: ReturnType<typeof useTranslations<'shortcuts'>>,
  scope: string,
): string | null {
  const key = `scopeHint.${scope}` as ScopedMessageKey<'shortcuts'>;
  return tShortcuts.has(key) ? tShortcuts(key) : null;
}

/** app全体で現在有効なキーボードショートカットを、検索とscopeに応じて並び替えて表示する。 */
export function ShortcutCheatSheetDialog({
  open,
  onOpenChange,
  catalog,
  activeScope,
  platform,
}: ShortcutCheatSheetDialogProps) {
  const t = useTranslations();
  const tShortcuts = useTranslations('shortcuts');
  const hasMounted = useHasMounted();
  const resolvedPlatform = platform ?? (hasMounted ? detectShortcutPlatform() : 'other');
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return catalog.groups
      .map((group) => {
        const items = catalog.entries
          .filter((entry) => entry.groupId === group.id)
          .map((entry) => ({
            labelKey: entry.labelKey,
            keyLabels: [
              ...new Set(entry.keys.map((key) => formatShortcutKey(key, resolvedPlatform))),
            ],
          }))
          .filter(({ labelKey, keyLabels }) => {
            if (!normalizedQuery) return true;
            const haystack = `${t(labelKey)} ${keyLabels.join(' ')}`.toLowerCase();
            return haystack.includes(normalizedQuery);
          });

        return { group, rank: getShortcutScopeRank(group, activeScope), items };
      })
      .filter((section) => section.items.length > 0)
      .sort((a, b) => a.rank - b.rank || a.group.order - b.group.order);
  }, [catalog, query, resolvedPlatform, activeScope, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} responsive="dialog" modal={false}>
      <DialogContent size="lg" className="flex max-h-160 flex-col overflow-hidden">
        <DialogHeader className="text-left">
          <DialogTitle>{tShortcuts('title')}</DialogTitle>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tShortcuts('searchPlaceholder')}
            aria-label={tShortcuts('searchLabel')}
            className="pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          {sections.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm" role="status">
              {tShortcuts('noResults')}
            </p>
          ) : (
            sections.map(({ group, rank, items }) => {
              const isActive = rank < 2;
              return (
                <section key={group.id} aria-labelledby={`shortcut-cheat-sheet-${group.id}`}>
                  <h3
                    id={`shortcut-cheat-sheet-${group.id}`}
                    className="text-muted-foreground px-2 text-xs font-medium"
                  >
                    {t(group.labelKey)}
                    {isActive ? null : (
                      <span className="ml-2 font-normal">{scopeHint(tShortcuts, group.scope)}</span>
                    )}
                  </h3>
                  <dl className={isActive ? undefined : 'text-muted-foreground'}>
                    {items.map(({ labelKey, keyLabels }) => (
                      <div
                        key={labelKey}
                        className="flex min-h-10 items-center justify-between gap-4 px-2 py-2 text-sm"
                      >
                        <dt>{t(labelKey)}</dt>
                        <dd className="flex shrink-0 items-center gap-1">
                          {keyLabels.map((keyLabel) => (
                            <kbd
                              key={keyLabel}
                              className="border-border bg-surface-container text-muted-foreground min-w-8 rounded-lg border px-2 py-1 text-center font-mono text-xs"
                            >
                              {keyLabel}
                            </kbd>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
