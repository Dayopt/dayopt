'use client';

import { useState } from 'react';

import { Plus, Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SidebarSection } from '@/components/shell/sidebar';
import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';
import { Button, HoverTooltip } from '@dayopt/components';

import { TemplateRow } from './TemplateRow';
import type { TemplateView } from './types';

interface TemplateListProps {
  templates: ReadonlyArray<TemplateView>;
  onApplyTemplate?: ((templateId: string) => void) | undefined;
  onEditTemplate?: ((templateId: string) => void) | undefined;
  onRenameTemplate?: ((templateId: string, name: string) => void) | undefined;
  onDeleteTemplate?: ((templateId: string) => void) | undefined;
  /** 見出しの「+」（カテゴリ / 未分類と同じ hover アクション）。実配線は #2567。 */
  onCreateEntry?: (() => void) | undefined;
  /** 見出しの歯車（カテゴリ / 未分類と同じ hover アクション）。実配線は #2567。 */
  onOpenSettings?: (() => void) | undefined;
}

/**
 * サイドバーのテンプレート列（v1.0 §5.1）。
 *
 * カテゴリー樹（`ActivityFilterList`）とは別枠のフラットな一覧。
 * カテゴリー分けは持たない（テンプレートはカテゴリーではなく「並べ方」を保存する）。
 *
 * 見出しの hover アクション（+ / 歯車）は「カテゴリ」「未分類」と同じ視覚パターンで
 * 先に置く。中身（作成導線・設定内容）は #2567 で配線するため、現状 `onCreateEntry` /
 * `onOpenSettings` を渡さなければ何も起きない（見た目だけ先行）。
 *
 * データ取得（tRPC）は #2567 で配線する。ここでは `templates` を props で
 * 受け取るだけの表示専用コンポーネント。
 *
 * 削除だけは props をそのまま呼ばず、必ず確認を挟む（2026-09-04 User 指示）。
 * アクティビティ / カテゴリーと同じく不可逆な操作のため。
 */
export function TemplateList({
  templates,
  onApplyTemplate,
  onEditTemplate,
  onRenameTemplate,
  onDeleteTemplate,
  onCreateEntry,
  onOpenSettings,
}: TemplateListProps) {
  const t = useTranslations();
  // 開閉状態。カテゴリ・未分類と同じく既定は展開
  const [collapsed, setCollapsed] = useState(false);
  // 削除確認の対象。null なら閉じている
  const [deleteTarget, setDeleteTarget] = useState<TemplateView | null>(null);

  return (
    // 次のセクション（未分類）との余白は、自分が開いているかどうかで自分の下に
    // margin-bottom を足す形で決める（開＝下に24px / 閉＝下に8px）。次側の
    // margin-top で決めると、開閉するたびに自分の見出し位置がずれてしまう
    // （2026-09-04 User 指摘）
    <div className={collapsed ? 'mb-2' : 'mb-6'}>
      <SidebarSection
        title={t('calendar.templates.sectionTitle')}
        className="space-y-1"
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((prev) => !prev)}
        action={
          // 常時は隠し、見出し行にホバー / フォーカスした時だけ出す
          // （「未分類」の action と同じ visibility パターン）
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100">
            <HoverTooltip content={t('calendar.templates.createLabel')} side="top">
              <Button
                variant="ghost"
                icon
                className="size-6"
                aria-label={t('calendar.templates.createLabel')}
                onClick={() => onCreateEntry?.()}
              >
                <Plus className="size-4" />
              </Button>
            </HoverTooltip>
            <HoverTooltip content={t('calendar.templates.settingsLabel')} side="top">
              <Button
                variant="ghost"
                icon
                className="size-6"
                aria-label={t('calendar.templates.settingsLabel')}
                onClick={() => onOpenSettings?.()}
              >
                <Settings2 className="size-4" />
              </Button>
            </HoverTooltip>
          </span>
        }
      >
        {templates.length === 0 ? (
          <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
            {t('calendar.templates.empty')}
          </p>
        ) : (
          <div role="list" className="space-y-1">
            {templates.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                onApply={() => onApplyTemplate?.(template.id)}
                onEdit={() => onEditTemplate?.(template.id)}
                onRename={(name) => onRenameTemplate?.(template.id, name)}
                onDelete={() => setDeleteTarget(template)}
              />
            ))}
          </div>
        )}

        <ConfirmDialog
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget) onDeleteTemplate?.(deleteTarget.id);
            setDeleteTarget(null);
          }}
          title={t('calendar.templates.deleteConfirmTitle', { name: deleteTarget?.name ?? '' })}
          description={t('calendar.templates.deleteConfirmDescription')}
          confirmLabel={t('calendar.templates.deleteConfirmButton')}
          variant="destructive"
        />
      </SidebarSection>
    </div>
  );
}
