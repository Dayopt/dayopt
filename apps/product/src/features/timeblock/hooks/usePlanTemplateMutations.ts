'use client';

/**
 * テンプレート（型）の mutation 群（#2567）。
 *
 * `optimistic-update` skill の 3 段（onMutate で cache 更新 / onError で rollback /
 * onSettled で再検証）に従う。適用（applyToDay）だけは plans の list cache へ temp 行を
 * 置くため、`useTimeblockWriteMutations` と同じ snapshot 単位を共有する
 * （両方が同じ cache を触るので、rollback 単位が食い違うと片方の巻き戻しが不完全になる）。
 *
 * 削除は不可逆なので楽観的更新の対象外（AGENTS.md）。確認ダイアログは `TemplateList` が持つ。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

import { materializeTemplateDay } from '../domain/plan-template-materialize';

import {
  getTimeblockServiceCode,
  insertTimeModelRowIntoMatchingLists,
  isTimeblockOverlapError,
  removeTimeModelRowsFromMatchingLists,
  restoreTimeblockLists,
  snapshotTimeblockLists,
  useTimeblockWriteMutations,
  type TimeblockListsSnapshot,
} from './useTimeblockWriteMutations';

interface ApplyMutationContext extends TimeblockListsSnapshot {
  tempIds: Set<string>;
}

const EMPTY_MEDIANS: ReadonlyMap<string, number> = new Map();
const EMPTY_ARCHIVED: ReadonlySet<string> = new Set();

export function usePlanTemplateMutations() {
  const utils = api.useUtils();
  // 適用の取り消しは同じ削除経路を通す（楽観的更新と失敗時のトーストを共有する）
  const { deletePlan } = useTimeblockWriteMutations();
  const queryClient = useQueryClient();
  const t = useTranslations();
  const timezone = useUserPreferences((preferences) => preferences.timezone);
  const defaultDuration = useUserPreferences((preferences) => preferences.defaultDuration);

  type PlanListItem = NonNullable<Awaited<ReturnType<typeof utils.plans.list.fetch>>>[number];
  type TemplateListItem = NonNullable<
    Awaited<ReturnType<typeof utils.planTemplates.list.fetch>>
  >[number];

  /**
   * 適用結果の見込みを client 側で作る。長さは `list` が返した `previewDurationMinutes`
   * をそのまま使う（hover プレビューと同じ値）。server は同じ pure function を通すので、
   * archived activity の null 化以外は同じ行になる。
   */
  const buildOptimisticPlans = (template: TemplateListItem, dateKey: string): PlanListItem[] => {
    const nowIso = new Date().toISOString();
    return materializeTemplateDay({
      blocks: template.blocks.map((block) => ({
        id: block.id,
        activityId: block.activityId,
        title: block.title,
        anchorMinute: block.anchorMinute,
      })),
      dateKey,
      timezone,
      medianMinutesByActivity: EMPTY_MEDIANS,
      defaultMinutes: defaultDuration,
      archivedActivityIds: EMPTY_ARCHIVED,
      preferredMinutesByBlockId: new Map(
        template.blocks.map((block) => [block.id, block.previewDurationMinutes]),
      ),
    }).map((plan) => ({
      id: `temp-${template.id}-${plan.blockId}`,
      user_id: '',
      activity_id: plan.activityId,
      external_calendar_event_id: null,
      title: plan.title,
      note: null,
      start_at: plan.startAt,
      end_at: plan.endAt,
      source: 'manual',
      deleted_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    }));
  };

  const applyToDay = api.planTemplates.applyToDay.useMutation({
    retry: false,
    onMutate: async (input): Promise<ApplyMutationContext> => {
      const snapshot = await snapshotTimeblockLists(queryClient);
      const template = utils.planTemplates.list
        .getData()
        ?.find((candidate) => candidate.id === input.templateId);
      if (!template) return { ...snapshot, tempIds: new Set() };

      let optimisticPlans: PlanListItem[];
      try {
        optimisticPlans = buildOptimisticPlans(template, input.date);
      } catch {
        // 具現化できない型（clip 後 5 分未満など）は server が同じ判定で弾く。
        // 楽観行を出さずに server の応答を待つ。
        return { ...snapshot, tempIds: new Set() };
      }

      for (const plan of optimisticPlans) {
        insertTimeModelRowIntoMatchingLists(queryClient, 'plans', plan);
      }
      return { ...snapshot, tempIds: new Set(optimisticPlans.map((plan) => plan.id)) };
    },
    onSuccess: (rows, _input, context) => {
      removeTimeModelRowsFromMatchingLists(queryClient, 'plans', context?.tempIds ?? new Set());
      for (const row of rows) {
        insertTimeModelRowIntoMatchingLists(queryClient, 'plans', row);
      }
      if (rows.length === 0) return;
      // 1 タップで複数件が増える操作なので、まとめて戻せる口をその場で渡す
      toast.success(t('calendar.templates.toast.applied', { count: rows.length }), {
        action: {
          label: t('common.undo'),
          onClick: () => {
            for (const row of rows) {
              deletePlan.mutate({ id: row.id, expectedUpdatedAt: row.updated_at });
            }
          },
        },
      });
    },
    onError: (error, _input, context) => {
      restoreTimeblockLists(queryClient, context);
      toast.error(
        isTimeblockOverlapError(error)
          ? t('calendar.templates.toast.applyOverlap')
          : getTimeblockServiceCode(error) === 'TEMPLATE_DOES_NOT_FIT'
            ? t('calendar.templates.toast.applyDoesNotFit')
            : t('calendar.templates.toast.applyFailed'),
      );
    },
    onSettled: () => {
      void utils.plans.invalidate();
    },
  });

  const createTemplate = api.planTemplates.create.useMutation({
    retry: false,
    onError: () => {
      toast.error(t('calendar.templates.toast.saveFailed'));
    },
    onSettled: () => {
      void utils.planTemplates.list.invalidate();
    },
  });

  const renameTemplate = api.planTemplates.rename.useMutation({
    retry: false,
    onMutate: async (input) => {
      await utils.planTemplates.list.cancel();
      const previous = utils.planTemplates.list.getData();
      utils.planTemplates.list.setData(undefined, (old) =>
        old?.map((template) =>
          template.id === input.templateId ? { ...template, name: input.name } : template,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      utils.planTemplates.list.setData(undefined, context?.previous);
      toast.error(t('calendar.templates.toast.renameFailed'));
    },
    onSettled: () => {
      void utils.planTemplates.list.invalidate();
    },
  });

  // 削除は不可逆なので楽観的更新を持たない（確認ダイアログ後、server の応答で消す）
  const deleteTemplate = api.planTemplates.delete.useMutation({
    retry: false,
    onError: () => {
      toast.error(t('calendar.templates.toast.deleteFailed'));
    },
    onSettled: () => {
      void utils.planTemplates.list.invalidate();
    },
  });

  return { applyToDay, createTemplate, renameTemplate, deleteTemplate };
}
