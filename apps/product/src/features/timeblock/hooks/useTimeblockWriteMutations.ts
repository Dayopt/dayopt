'use client';

import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

/** 一時ID生成（楽観的作成用） */
function createTempId(): string {
  return `temp-${Date.now()}`;
}

function isLaneListQuery(lane: 'plans' | 'records') {
  return (query: { queryKey: unknown }): boolean => {
    const key = query.queryKey;
    return (
      Array.isArray(key) && Array.isArray(key[0]) && key[0][0] === lane && key[0][1] === 'list'
    );
  };
}

const isPlansListQuery = isLaneListQuery('plans');
const isRecordsListQuery = isLaneListQuery('records');

function isTimeblockQuery(query: { queryKey: unknown }): boolean {
  const key = query.queryKey;
  return (
    Array.isArray(key) &&
    Array.isArray(key[0]) &&
    (key[0][0] === 'plans' || key[0][0] === 'records')
  );
}

function isTimeblockListQuery(query: { queryKey: unknown }): boolean {
  return isPlansListQuery(query) || isRecordsListQuery(query);
}

/**
 * plans / records の全 cache を退避する（テンプレート適用など、この hook の外の
 * mutation も同じ rollback 単位を使うため module 関数として公開する）。
 * cancel は list query だけに掛ける — in-flight の refetch が楽観行を上書きする窓を
 * 閉じるのが目的で、getById の再取得まで止める必要は無い。
 */
export async function snapshotTimeblockLists(
  queryClient: QueryClient,
): Promise<TimeblockListsSnapshot> {
  await queryClient.cancelQueries({ predicate: isTimeblockListQuery });
  return {
    snapshots: queryClient.getQueriesData({ predicate: isTimeblockQuery }) as Array<
      [QueryKey, unknown]
    >,
  };
}

/** `snapshotTimeblockLists` で取った cache を書き戻す。 */
export function restoreTimeblockLists(
  queryClient: QueryClient,
  context: TimeblockListsSnapshot | undefined,
): void {
  for (const [queryKey, data] of context?.snapshots ?? []) {
    queryClient.setQueryData(queryKey, data);
  }
}

interface TimeModelListFilter {
  ids?: string[];
  search?: string;
  activityId?: string;
  planId?: string;
  planIds?: string[];
  startDate?: string;
  endDate?: string;
  includeSkipped?: boolean;
  sortBy?: 'created_at' | 'updated_at' | 'title' | 'start_at';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface TimeModelListRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  skipped_at?: string | null;
  plan_id?: string | null;
}

function getListFilter(queryKey: unknown): TimeModelListFilter {
  if (!Array.isArray(queryKey)) return {};
  const meta = queryKey[1];
  if (!meta || typeof meta !== 'object') return {};
  const input = (meta as { input?: unknown }).input;
  return input && typeof input === 'object' ? (input as TimeModelListFilter) : {};
}

/** query input と行が一致するか。create の offset>0 cache は順位不明のため更新しない。 */
export function doesTimeModelListQueryIncludeRow(
  queryKey: unknown,
  row: TimeModelListRow,
  lane: 'plans' | 'records',
  operation: 'create' | 'update' = 'create',
): boolean {
  const filter = getListFilter(queryKey);
  if (row.deleted_at != null) return false;
  if (operation === 'create' && (filter.offset ?? 0) > 0) return false;
  if (lane === 'plans' && filter.ids && !filter.ids.includes(row.id)) return false;
  if (filter.activityId && row.activity_id !== filter.activityId) return false;
  if (lane === 'records' && filter.planId && row.plan_id !== filter.planId) return false;
  if (
    lane === 'records' &&
    filter.planIds &&
    (row.plan_id == null || !filter.planIds.includes(row.plan_id))
  )
    return false;
  if (lane === 'plans' && filter.includeSkipped === false && row.skipped_at != null) return false;

  // アクティビティ名はlist rowだけでは解決できないため、検索cacheの一致判定はserver再検証へ任せる。
  if (filter.search) return false;

  if (filter.startDate && filter.endDate) {
    if (!(
      Date.parse(row.start_at) < Date.parse(filter.endDate) &&
      Date.parse(row.end_at) > Date.parse(filter.startDate)
    ))
      return false;
  } else if (filter.startDate && Date.parse(row.start_at) < Date.parse(filter.startDate)) {
    return false;
  } else if (filter.endDate && Date.parse(row.start_at) > Date.parse(filter.endDate)) {
    return false;
  }

  return true;
}

function sortAndLimitRows<T extends TimeModelListRow>(
  rows: T[],
  queryKey: unknown,
  lane: 'plans' | 'records',
): T[] {
  const filter = getListFilter(queryKey);
  const sortBy = filter.sortBy ?? 'start_at';
  const sortOrder = filter.sortOrder ?? (lane === 'plans' ? 'asc' : 'desc');
  const sorted = [...rows].sort((a, b) => {
    const comparison = String(a[sortBy]).localeCompare(String(b[sortBy]));
    return sortOrder === 'asc' ? comparison : -comparison;
  });
  return filter.limit ? sorted.slice(0, filter.limit) : sorted;
}

export function insertTimeModelRowIntoMatchingLists<T extends TimeModelListRow>(
  queryClient: QueryClient,
  lane: 'plans' | 'records',
  row: T,
  replaceId?: string,
): void {
  const predicate = lane === 'plans' ? isPlansListQuery : isRecordsListQuery;
  for (const [queryKey, data] of queryClient.getQueriesData<T[]>({ predicate })) {
    if (getListFilter(queryKey).search) continue;
    if (!doesTimeModelListQueryIncludeRow(queryKey, row, lane, 'create')) continue;
    const old = data ?? [];
    const next = old.filter((candidate) => candidate.id !== replaceId && candidate.id !== row.id);
    queryClient.setQueryData(queryKey, sortAndLimitRows([...next, row], queryKey, lane));
  }
}

/** 指定 id の行を、現在保持している全 list cache から取り除く（temp 行の掃除・削除の楽観更新）。 */
export function removeTimeModelRowsFromMatchingLists(
  queryClient: QueryClient,
  lane: 'plans' | 'records',
  ids: ReadonlySet<string>,
): void {
  if (ids.size === 0) return;
  const predicate = lane === 'plans' ? isPlansListQuery : isRecordsListQuery;
  queryClient.setQueriesData<TimeModelListRow[]>({ predicate }, (old) =>
    old?.filter((row) => !ids.has(row.id)),
  );
}

/** DBが返した確定行を、現在保持している全list cacheへ反映する。 */
function replaceTimeModelRowInMatchingLists<T extends TimeModelListRow>(
  queryClient: QueryClient,
  lane: 'plans' | 'records',
  row: T,
): void {
  const predicate = lane === 'plans' ? isPlansListQuery : isRecordsListQuery;
  for (const [queryKey, data] of queryClient.getQueriesData<T[]>({ predicate })) {
    const filter = getListFilter(queryKey);
    if (filter.search) continue;

    const old = data ?? [];
    const containsRow = old.some((candidate) => candidate.id === row.id);
    const shouldInclude = doesTimeModelListQueryIncludeRow(queryKey, row, lane, 'update');

    if (!shouldInclude) {
      if (containsRow) {
        queryClient.setQueryData(
          queryKey,
          old.filter((candidate) => candidate.id !== row.id),
        );
      }
      continue;
    }

    if (!containsRow && (filter.offset ?? 0) > 0) continue;
    const withoutRow = old.filter((candidate) => candidate.id !== row.id);
    queryClient.setQueryData(queryKey, sortAndLimitRows([...withoutRow, row], queryKey, lane));
  }
}

/** server が返した ServiceError code（allowlist に載ったものだけ client へ届く）。 */
export function getTimeblockServiceCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== 'object' || !('serviceCode' in data)) return undefined;
  return typeof data.serviceCode === 'string' ? data.serviceCode : undefined;
}

/** DB の EXCLUDE 制約（`plans_no_overlap` / 23P01）由来の重複エラーか。 */
export function isTimeblockOverlapError(error: { message: string }): boolean {
  return (
    getTimeblockServiceCode(error) === 'TIME_OVERLAP' || error.message.includes('TIME_OVERLAP')
  );
}

export function isTimeblockStaleError(error: unknown): boolean {
  const code = getTimeblockServiceCode(error);
  return code === 'STALE_VERSION' || code === 'STALE_TARGET';
}

export function isTimeblockUncertainError(error: unknown): boolean {
  const code = getTimeblockServiceCode(error);
  return code === undefined || code === 'RETRYABLE_CONTENTION' || code === 'TEMPORARY_FAILURE';
}

export interface TimeblockListsSnapshot {
  snapshots: ReadonlyArray<readonly [QueryKey, unknown]>;
}

interface MutationContext extends TimeblockListsSnapshot {
  tempId?: string;
}

interface UseTimeblockWriteMutationsOptions {
  /** create の時間重複をフォーム内で表示する場合に指定する。指定時は重複トーストを出さない。 */
  onCreateTimeOverlap?: (() => void) | undefined;
  /** update の時間重複をフォーム内で表示する場合に指定する。指定時は重複トーストを出さない。 */
  onUpdateTimeOverlap?: ((input: TimeblockOverlapUpdateInput) => void) | undefined;
}

export interface TimeblockOverlapUpdateInput {
  id: string;
  data: {
    start_at?: string | undefined;
    end_at?: string | undefined;
  };
}

/**
 * Plan / Record の書き込み mutation 群。
 *
 * optimistic-update skill に従い、create は temp 行 insert、update は該当行 patch、
 * delete は行除去を onMutate で行い、onError で snapshot rollback、onSettled で再検証する。
 */
export function useTimeblockWriteMutations(options: UseTimeblockWriteMutationsOptions = {}) {
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const t = useTranslations('timeblock.editor');
  const { onCreateTimeOverlap, onUpdateTimeOverlap } = options;

  type PlanListItem = NonNullable<Awaited<ReturnType<typeof utils.plans.list.fetch>>>[number];
  type RecordListItem = NonNullable<Awaited<ReturnType<typeof utils.records.list.fetch>>>[number];

  const snapshot = (): Promise<MutationContext> => snapshotTimeblockLists(queryClient);

  const restore = (context: MutationContext | undefined) => {
    restoreTimeblockLists(queryClient, context);
  };

  /**
   * server が時刻規則で拒否した時の文言（`end_at > start_at` = DT003 /
   * Record は未来に終われない = DT005）。
   *
   * 規則の強制点は DB trigger で、UI 側の事前チェックは往復を減らす写しにすぎない
   * （`invariants.md` §時刻 の分類 (b)）。写しを外しても文言が汎用 saveFailed へ
   * 退化しないよう、server 由来の code をここで拾う（#2628）。code は
   * `client-safe-service-code.ts` の allowlist に載っているものだけが届く。
   */
  const temporalRuleMessage = (error: unknown): string | undefined => {
    switch (getTimeblockServiceCode(error)) {
      case 'RECORD_IN_FUTURE':
        return t('timeLocked');
      case 'INVALID_TIME_RANGE':
        return t('duplicate.validation.invalidRange');
      default:
        return undefined;
    }
  };

  const reportError = (error: { message: string }) => {
    toast.error(
      temporalRuleMessage(error) ??
        (isTimeblockOverlapError(error)
          ? t('toast.overlap')
          : isTimeblockStaleError(error)
            ? t('toast.conflict')
            : t('toast.saveFailed')),
    );
  };

  const reportCreateError = (error: { message: string }) => {
    if (isTimeblockOverlapError(error) && onCreateTimeOverlap) {
      onCreateTimeOverlap();
      return;
    }
    reportError(error);
  };

  const reportUpdateError = (error: { message: string }, input: TimeblockOverlapUpdateInput) => {
    if (isTimeblockOverlapError(error) && onUpdateTimeOverlap) {
      onUpdateTimeOverlap(input);
      return;
    }
    reportError(error);
  };

  const insertIntoMatchingLists = <T extends TimeModelListRow>(
    lane: 'plans' | 'records',
    row: T,
    replaceId?: string,
  ) => {
    insertTimeModelRowIntoMatchingLists(queryClient, lane, row, replaceId);
  };

  const replaceServerRow = <T extends TimeModelListRow>(lane: 'plans' | 'records', row: T) => {
    replaceTimeModelRowInMatchingLists(queryClient, lane, row);
  };

  const patchMatchingLists = <T extends TimeModelListRow>(
    lane: 'plans' | 'records',
    id: string,
    patch: (row: T) => T,
  ) => {
    const predicate = lane === 'plans' ? isPlansListQuery : isRecordsListQuery;
    for (const [queryKey, data] of queryClient.getQueriesData<T[]>({ predicate })) {
      if (getListFilter(queryKey).search) continue;
      if (!data?.some((row) => row.id === id)) continue;
      const patched = data.map((row) => (row.id === id ? patch(row) : row));
      const filtered = patched.filter(
        (row) => row.id !== id || doesTimeModelListQueryIncludeRow(queryKey, row, lane, 'update'),
      );
      queryClient.setQueryData(queryKey, sortAndLimitRows(filtered, queryKey, lane));
    }
  };

  // getById も対象に含めて router 全体を再検証する（Inspector の updated_at 鮮度を保つ）
  const invalidate = () => {
    void utils.plans.invalidate();
    void utils.records.invalidate();
  };

  const createPlan = api.planCommands.create.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const tempId = createTempId();
      const nowIso = new Date().toISOString();
      const tempPlan: PlanListItem = {
        id: tempId,
        user_id: '',
        activity_id: input.activityId ?? null,
        external_calendar_event_id: input.externalCalendarEventId ?? null,
        title: input.title,
        note: input.note ?? null,
        start_at: input.start_at,
        end_at: input.end_at,
        skipped_at: null,
        source: 'manual',
        deleted_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      insertIntoMatchingLists('plans', tempPlan);
      return { ...context, tempId };
    },
    onSuccess: (created, _input, context) => {
      if (!created) return;
      insertIntoMatchingLists('plans', created, context?.tempId);
      utils.plans.getById.setData({ id: created.id }, created);
    },
    onError: (error, _input, context) => {
      restore(context);
      reportCreateError(error);
    },
    onSettled: invalidate,
  });

  const createRecord = api.recordCommands.create.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const tempId = createTempId();
      const nowIso = new Date().toISOString();
      const tempRecord: RecordListItem = {
        id: tempId,
        user_id: '',
        activity_id: input.activityId ?? null,
        plan_id: input.planId ?? null,
        external_calendar_event_id: input.externalCalendarEventId ?? null,
        title: input.title,
        note: input.note ?? null,
        start_at: input.start_at,
        end_at: input.end_at,
        source: 'manual',
        fulfillment: input.fulfillment ?? null,
        deleted_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      insertIntoMatchingLists('records', tempRecord);
      return { ...context, tempId };
    },
    onSuccess: (created, _input, context) => {
      if (!created) return;
      insertIntoMatchingLists('records', created, context?.tempId);
      utils.records.getById.setData({ id: created.id }, created);
    },
    onError: (error, _input, context) => {
      restore(context);
      reportCreateError(error);
    },
    onSettled: invalidate,
  });

  const updatePlan = api.planCommands.update.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const patch = (row: PlanListItem): PlanListItem => ({
        ...row,
        ...(input.data.title !== undefined ? { title: input.data.title } : {}),
        ...(input.data.note !== undefined ? { note: input.data.note ?? null } : {}),
        ...(input.data.start_at !== undefined ? { start_at: input.data.start_at } : {}),
        ...(input.data.end_at !== undefined ? { end_at: input.data.end_at } : {}),
      });
      patchMatchingLists('plans', input.id, patch);
      utils.plans.getById.setData({ id: input.id }, (old) => (old ? patch(old) : old));
      return context;
    },
    onSuccess: (updated) => {
      replaceServerRow('plans', updated);
      utils.plans.getById.setData({ id: updated.id }, updated);
    },
    onError: (error, input, context) => {
      restore(context);
      reportUpdateError(error, input);
    },
    onSettled: invalidate,
  });

  const updateRecord = api.recordCommands.update.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const patch = (row: RecordListItem): RecordListItem => ({
        ...row,
        ...(input.data.title !== undefined ? { title: input.data.title } : {}),
        ...(input.data.note !== undefined ? { note: input.data.note ?? null } : {}),
        ...(input.data.start_at !== undefined ? { start_at: input.data.start_at } : {}),
        ...(input.data.end_at !== undefined ? { end_at: input.data.end_at } : {}),
        ...(input.data.fulfillment !== undefined ? { fulfillment: input.data.fulfillment } : {}),
      });
      patchMatchingLists('records', input.id, patch);
      utils.records.getById.setData({ id: input.id }, (old) => (old ? patch(old) : old));
      return context;
    },
    onSuccess: (updated) => {
      replaceServerRow('records', updated);
      utils.records.getById.setData({ id: updated.id }, updated);
    },
    onError: (error, input, context) => {
      restore(context);
      reportUpdateError(error, input);
    },
    onSettled: invalidate,
  });

  const reportDeleteError = () => toast.error(t('toast.deleteFailed'));
  const reportRestoreError = () => toast.error(t('toast.restoreFailed'));

  const deletePlan = api.planCommands.delete.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      queryClient.setQueriesData<PlanListItem[]>({ predicate: isPlansListQuery }, (old) =>
        old?.filter((row) => row.id !== input.id),
      );
      utils.plans.getById.setData({ id: input.id }, undefined);
      return context;
    },
    onError: (_error, _input, context) => {
      restore(context);
      reportDeleteError();
    },
    onSettled: invalidate,
  });

  const deleteRecord = api.recordCommands.delete.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      queryClient.setQueriesData<RecordListItem[]>({ predicate: isRecordsListQuery }, (old) =>
        old?.filter((row) => row.id !== input.id),
      );
      utils.records.getById.setData({ id: input.id }, undefined);
      return context;
    },
    onError: (_error, _input, context) => {
      restore(context);
      reportDeleteError();
    },
    onSettled: invalidate,
  });

  const restorePlan = api.planCommands.restore.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (restored) => {
      insertIntoMatchingLists('plans', restored);
      utils.plans.getById.setData({ id: restored.id }, restored);
    },
    onError: (_error, _input, context) => {
      restore(context);
      reportRestoreError();
    },
    onSettled: invalidate,
  });

  const restoreRecord = api.recordCommands.restore.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (restored) => {
      insertIntoMatchingLists('records', restored);
      utils.records.getById.setData({ id: restored.id }, restored);
    },
    onError: (_error, _input, context) => {
      restore(context);
      reportRestoreError();
    },
    onSettled: invalidate,
  });

  const skipPlan = api.planCommands.skip.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (updated) => {
      replaceServerRow('plans', updated);
      utils.plans.getById.setData({ id: updated.id }, updated);
    },
    onError: (_error, _input, context) => {
      restore(context);
      toast.error(t('toast.skipFailed'));
    },
    onSettled: invalidate,
  });

  const unskipPlan = api.planCommands.unskip.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (updated) => {
      replaceServerRow('plans', updated);
      utils.plans.getById.setData({ id: updated.id }, updated);
    },
    onError: (_error, _input, context) => {
      restore(context);
      toast.error(t('toast.skipFailed'));
    },
    onSettled: invalidate,
  });

  const fetchPlanById = async (id: string) => {
    await utils.plans.getById.invalidate({ id });
    return utils.plans.getById.fetch({ id });
  };
  const fetchRecordById = async (id: string) => {
    await utils.records.getById.invalidate({ id });
    return utils.records.getById.fetch({ id });
  };

  return {
    createRecord,
    createPlan,
    deleteRecord,
    deletePlan,
    fetchPlanById,
    fetchRecordById,
    restoreRecord,
    restorePlan,
    skipPlan,
    unskipPlan,
    updateRecord,
    updatePlan,
  };
}
