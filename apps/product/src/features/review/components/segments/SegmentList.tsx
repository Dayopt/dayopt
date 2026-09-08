'use client';

import { useState } from 'react';

import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SidebarSection } from '@/components/shell/sidebar';
import { EmptyState } from '@/components/ui/feedback/EmptyState';
import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
} from '@dayopt/components';

import { useActiveSegment } from '../../hooks/useActiveSegment';
import {
  useDeleteSegment,
  useRenameSegment,
  useSegments,
  useSetSegmentActivities,
} from '../../hooks/useSegments';
import { useReportViewStore } from '../../stores/useReportViewStore';
import { SegmentCreateDialog } from './SegmentCreateDialog';
import { SegmentEditDialog } from './SegmentEditDialog';

/**
 * サイドバーの「セグメント」（仕様 §3.3-2）。
 *
 * 1 本の一覧がレンズ選択（行クリック）と CRUD（⋯ メニュー）の両方を担う。同じ名前を
 * 2 度並べない — 狭いサイドバーで同じ一覧が 2 つあると、どちらを押せばよいか読めなくなる
 * （2026-09-04 User 裁可）。
 *
 * 見出しと作成導線はカレンダーの「カテゴリ」見出しと同じ構成に揃える（2026-09-07 User 指示）:
 * `SidebarSection` の action スロットに `+` を置き、hover / focus 時だけ出す。
 *
 * レンズは「すべて」が既定。選ぶと 1 章の宇宙が `segment.activityIds ∩ visible` に縮む
 * （仕様 §2.4）。並び替え・フォルダ分け・共有は持たない（v1 スコープ外）。
 */
export function SegmentList() {
  const t = useTranslations('calendar.stats.review.segments');
  const tSidebar = useTranslations('report.sidebar');
  const { data: segments, isPending } = useSegments();
  const renameSegment = useRenameSegment();
  const setSegmentActivities = useSetSegmentActivities();
  const deleteSegment = useDeleteSegment();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // 編集ダイアログはメニューの中ではなく一覧の外に 1 つだけ置く。`DropdownMenuContent` の
  // 中に Dialog を入れると、メニューを閉じる時のフォーカス戻しと Dialog の開閉が競合する
  // （同ファイルの削除確認が既に取っている流儀に合わせる）
  const [editingId, setEditingId] = useState<string | null>(null);
  // 作成ダイアログ展開中は見出しの `+` を強制表示する（カレンダーの #2211 と同じ扱い）
  const [createOpen, setCreateOpen] = useState(false);

  const segmentId = useReportViewStore((state) => state.segmentId);
  const setSegmentId = useReportViewStore((state) => state.setSegmentId);

  const pendingDeleteSegment = segments?.find((s) => s.id === pendingDeleteId) ?? null;
  const editingSegment = segments?.find((s) => s.id === editingId) ?? null;

  // 削除済みセグメントの縮退は hook が持つ（1 章・カテゴリーフィルタと同じ答えを使う）
  const { activeSegment } = useActiveSegment();
  const activeSegmentId = activeSegment?.id ?? null;
  // この一覧はデスクトップのサイドバー専用（モバイルは `ReportFilterChipRow` の Drawer が
  // レンズ選択を持つ）。`useIsMobile()` はここでは恒真で false だったので分岐ごと落とした（#2582）
  const rowHeight = 'min-h-9';

  return (
    <SidebarSection
      title={tSidebar('lensHeading')}
      className="flex flex-col gap-1"
      action={
        // カレンダーの「カテゴリ」見出しと同じ式: 常時は隠し、見出し行に hover / focus
        // した時だけ出す。ダイアログ展開中は createOpen で強制表示する
        <span
          className={cn(
            'transition-opacity',
            createOpen
              ? 'opacity-100'
              : 'opacity-0 group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          <SegmentCreateDialog onOpenChange={setCreateOpen} />
        </span>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-1">
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {/* レンズ無し。セグメントが 1 つも無くても押せる状態として常に置く */}
          <li>
            <button
              type="button"
              aria-pressed={activeSegmentId === null}
              onClick={() => setSegmentId(null)}
              className={cn(
                'hover:bg-state-hover flex w-full items-center rounded-lg px-2 text-left text-sm',
                rowHeight,
                activeSegmentId === null && 'bg-state-selected',
              )}
            >
              {tSidebar('lensAll')}
            </button>
          </li>

          {segments?.map((segment) => (
            <li
              key={segment.id}
              className={cn(
                'group hover:bg-state-hover flex items-center gap-1 rounded-lg pr-2',
                rowHeight,
                activeSegmentId === segment.id && 'bg-state-selected',
              )}
            >
              <button
                type="button"
                aria-pressed={activeSegmentId === segment.id}
                onClick={() => setSegmentId(segment.id)}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-lg px-2 text-left text-sm',
                  rowHeight,
                )}
              >
                {segment.name}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    icon
                    className="size-6 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
                    // 行そのものがレンズ切替のボタンになったので、名前だけだと
                    // 読み上げで区別できず、切替のつもりで破壊的メニューを開いてしまう
                    aria-label={tSidebar('segmentMenu', { name: segment.name })}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditingId(segment.id)}>
                    {t('editActivities')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setPendingDeleteId(segment.id)}
                  >
                    {t('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      {!isPending && (!segments || segments.length === 0) ? (
        <EmptyState
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          size="sm"
          className="py-4"
        />
      ) : null}

      {editingSegment ? (
        <SegmentEditDialog
          open
          onOpenChange={(next) => {
            if (!next) setEditingId(null);
          }}
          title={t('editActivities')}
          initialName={editingSegment.name}
          initialActivityIds={editingSegment.activityIds}
          isSubmitting={renameSegment.isPending || setSegmentActivities.isPending}
          onSubmit={async (input) => {
            if (input.name !== editingSegment.name) {
              await renameSegment.mutateAsync({ segmentId: editingSegment.id, name: input.name });
            }
            await setSegmentActivities.mutateAsync({
              segmentId: editingSegment.id,
              activityIds: input.activityIds,
            });
            setEditingId(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDeleteSegment != null}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (pendingDeleteSegment) {
            // 削除するセグメントをレンズにしていたら「すべて」へ戻す
            if (segmentId === pendingDeleteSegment.id) setSegmentId(null);
            deleteSegment.mutate({ segmentId: pendingDeleteSegment.id });
          }
          setPendingDeleteId(null);
        }}
        title={t('deleteConfirmTitle')}
        description={
          pendingDeleteSegment
            ? t('deleteConfirmDescription', { name: pendingDeleteSegment.name })
            : ''
        }
        variant="destructive"
      />
    </SidebarSection>
  );
}
