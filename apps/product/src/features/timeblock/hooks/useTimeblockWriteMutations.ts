'use client';

import {
  CancelledError,
  isCancelledError,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

/** 一時ID生成（楽観的作成用） */
function createTempId(): string {
  return `temp-${crypto.randomUUID()}`;
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

/** Pending operations share a base, but each owns only its cache writes. */
interface CacheChange {
  queryKey: QueryKey;
  apply: (data: unknown, lookup: (id: string) => TimeModelListRow | undefined) => unknown;
  owner?: TimeblockListsSnapshot;
}
interface CacheJournal {
  base: ReadonlyArray<readonly [QueryKey, unknown]>;
  observed: ReadonlyArray<readonly [QueryKey, unknown]>;
  changes: CacheChange[];
  pending: Set<TimeblockListsSnapshot>;
  queries: Map<string, ReturnType<ReturnType<QueryClient['getQueryCache']>['getAll']>[number]>;
}
const cacheJournals = new WeakMap<QueryClient, CacheJournal>();

function cacheRows(data: unknown): data is TimeModelListRow[] {
  return Array.isArray(data) && data.every((row) => row && typeof row.id === 'string');
}

function readTimeblockCache(queryClient: QueryClient) {
  return queryClient.getQueriesData({ predicate: isTimeblockQuery });
}

function captureCacheChanges(
  queryClient: QueryClient,
  journal: CacheJournal,
  owner?: TimeblockListsSnapshot,
): void {
  const current = readTimeblockCache(queryClient);
  for (const [queryKey, after] of current) {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    const hash = query?.queryHash;
    if (query && !journal.queries.has(query.queryHash)) journal.queries.set(query.queryHash, query);
    const before = journal.observed.find(
      ([key]) =>
        queryClient.getQueryCache().find({ queryKey: key, exact: true })?.queryHash === hash,
    )?.[1];
    if (before === after) continue;
    if (
      !journal.base.some(
        ([key]) =>
          queryClient.getQueryCache().find({ queryKey: key, exact: true })?.queryHash === hash,
      )
    )
      journal.base = [...journal.base, [queryKey, before]];
    if (!owner) {
      // A refetch is authoritative, including rows absent from its response.
      journal.changes.push({ queryKey, apply: () => after });
    } else if (cacheRows(before) && cacheRows(after)) {
      const lane = isPlansListQuery({ queryKey }) ? 'plans' : 'records';
      const added = after.filter((row) => !before.some((old) => old.id === row.id));
      const moving = added.map((row) => {
        const source = journal.observed
          .flatMap(([key, data]) =>
            isLaneListQuery(lane)({ queryKey: key }) && cacheRows(data) ? data : [],
          )
          .find((old) => old.id === row.id);
        const fields = source
          ? Object.fromEntries(
              Object.entries(row).filter(
                ([key, value]) =>
                  !Object.is(value, (source as unknown as Record<string, unknown>)[key]),
              ),
            )
          : undefined;
        return { row, fields };
      });
      const removed = before.filter((row) => !after.some((next) => next.id === row.id));
      const patches = after.flatMap((row) => {
        const old = before.find((candidate) => candidate.id === row.id);
        if (!old) return [];
        const fields = Object.fromEntries(
          Object.entries(row).filter(
            ([key, value]) => !Object.is(value, (old as unknown as Record<string, unknown>)[key]),
          ),
        );
        return Object.keys(fields).length ? [{ id: row.id, fields }] : [];
      });
      // Limited-list insertion displaces persisted rows; replaced temporary rows must still be removed.
      const displaced = added.length > 0 && getListFilter(queryKey).limit !== undefined;
      journal.changes.push({
        queryKey,
        owner,
        apply: (data, lookup) => {
          const rows = cacheRows(data) ? data : [];
          const kept = rows.filter(
            (row) =>
              (displaced && !row.id.startsWith('temp-')) ||
              !removed.some((old) => old.id === row.id),
          );
          const patched = kept.map((row) => ({
            ...row,
            ...patches.find((patch) => patch.id === row.id)?.fields,
          }));
          return sortAndLimitRows(
            [
              ...patched.filter((row) => !added.some((next) => next.id === row.id)),
              ...moving.map(({ row, fields }) =>
                fields ? { ...(lookup(row.id) ?? row), ...fields } : row,
              ),
            ],
            queryKey,
            lane,
          );
        },
      });
    } else if (before && after && typeof before === 'object' && typeof after === 'object') {
      const fields = Object.fromEntries(
        Object.entries(after).filter(
          ([key, value]) => !Object.is(value, (before as Record<string, unknown>)[key]),
        ),
      );
      journal.changes.push({
        queryKey,
        owner,
        apply: (data) => ({
          ...(data && typeof data === 'object' ? data : before),
          ...fields,
        }),
      });
    } else {
      journal.changes.push({ queryKey, owner, apply: () => after });
    }
  }
  journal.observed = current;
}

export async function snapshotTimeblockLists(
  queryClient: QueryClient,
): Promise<TimeblockListsSnapshot> {
  const queries = queryClient.getQueryCache().getAll().filter(isTimeblockQuery);
  const mutations = queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'pending');
  await queryClient.cancelQueries({ predicate: isTimeblockListQuery });
  if (!isTimeblockCacheCurrent(queryClient, { queries, mutations })) {
    throw new CancelledError({ silent: true });
  }
  let journal = cacheJournals.get(queryClient);
  if (
    journal &&
    [...journal.pending].every((context) => !isTimeblockCacheCurrent(queryClient, context))
  ) {
    cacheJournals.delete(queryClient);
    journal = undefined;
  }
  if (!journal) {
    const base = readTimeblockCache(queryClient);
    journal = {
      base,
      observed: base,
      changes: [],
      pending: new Set(),
      queries: new Map(
        queryClient
          .getQueryCache()
          .getAll()
          .filter(isTimeblockQuery)
          .map((query) => [query.queryHash, query]),
      ),
    };
    cacheJournals.set(queryClient, journal);
  } else captureCacheChanges(queryClient, journal);
  const context: TimeblockListsSnapshot = {
    journal,
    operation: { failed: false },
    queries,
    mutations,
  };
  journal.pending.add(context);
  return context;
}

/** A removed query/mutation belongs to a retired cache (for example after logout). */
export function isTimeblockCacheCurrent(
  queryClient: QueryClient,
  context: Pick<TimeblockListsSnapshot, 'queries' | 'mutations'> | undefined,
): boolean {
  if (!context) return false;
  // Pending mutations cannot be garbage-collected. Other completed mutations can,
  // so requiring every captured mutation to remain would discard valid long requests.
  if (context.mutations.length > 0) {
    const mutations = queryClient.getMutationCache().getAll();
    return context.mutations.some((mutation) => mutations.includes(mutation));
  }
  return context.queries.every((query) => queryClient.getQueryCache().getAll().includes(query));
}

export function writeTimeblockCache(
  queryClient: QueryClient,
  context: TimeblockListsSnapshot,
  write: () => void,
  replay?: (queryKey: QueryKey, data: unknown) => unknown,
): void {
  if (!isTimeblockCacheCurrent(queryClient, context)) return;
  captureCacheChanges(queryClient, context.journal);
  write();
  if (replay) {
    const current = readTimeblockCache(queryClient);
    for (const [queryKey] of current) {
      context.journal.changes.push({
        queryKey,
        owner: context,
        apply: (data) => replay(queryKey, data),
      });
    }
    context.journal.observed = current;
  } else captureCacheChanges(queryClient, context.journal, context);
}

/** Record deletion intent even when a limited list has displaced the row. */
export function deleteTimeblockCacheRows(
  queryClient: QueryClient,
  context: TimeblockListsSnapshot,
  lane: 'plans' | 'records',
  ids: ReadonlySet<string>,
): void {
  writeTimeblockCache(queryClient, context, () =>
    removeTimeModelRowsFromMatchingLists(queryClient, lane, ids),
  );
  for (const [queryKey] of context.journal.base) {
    if (!isLaneListQuery(lane)({ queryKey })) continue;
    context.journal.changes.push({
      queryKey,
      owner: context,
      apply: (data) => (cacheRows(data) ? data.filter((row) => !ids.has(row.id)) : data),
    });
  }
}

export function settleTimeblockCache(
  queryClient: QueryClient,
  context: TimeblockListsSnapshot | undefined,
): void {
  if (!context) return;
  for (const pending of context.journal.pending) {
    if (pending.operation === context.operation) context.journal.pending.delete(pending);
  }
  if (context.journal.pending.size === 0 && cacheJournals.get(queryClient) === context.journal) {
    cacheJournals.delete(queryClient);
  }
}

/** Replay surviving writes; a later optimistic patch never restores a failed predecessor. */
export function restoreTimeblockLists(
  queryClient: QueryClient,
  context: TimeblockListsSnapshot | undefined,
): void {
  if (!context) return;
  if (isTimeblockCacheCurrent(queryClient, context)) {
    const journal = context.journal;
    captureCacheChanges(queryClient, journal);
    context.operation.failed = true;
    const states = new Map<string, { key: QueryKey; data: unknown }>(
      journal.base.flatMap(([key, data]) => {
        const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        return query && journal.queries.get(query.queryHash) === query
          ? [[query.queryHash, { key, data }] as const]
          : [];
      }),
    );
    const rows = new Map<string, TimeModelListRow>();
    const rememberRows = (queryKey: QueryKey, data: unknown) => {
      if (cacheRows(data)) {
        const lane = isPlansListQuery({ queryKey }) ? 'plans' : 'records';
        for (const row of data) rows.set(`${lane}:${row.id}`, row);
      }
    };
    for (const [key, data] of journal.base) rememberRows(key, data);
    for (const change of journal.changes) {
      if (change.owner?.operation.failed) continue;
      const hash = queryClient
        .getQueryCache()
        .find({ queryKey: change.queryKey, exact: true })?.queryHash;
      if (!hash) continue;
      const state = states.get(hash);
      if (!state) continue;
      const lane = isPlansListQuery({ queryKey: change.queryKey }) ? 'plans' : 'records';
      state.data = change.apply(state.data, (id) => rows.get(`${lane}:${id}`));
      rememberRows(state.key, state.data);
    }
    for (const { key, data } of states.values()) {
      if (data === undefined) queryClient.removeQueries({ queryKey: key, exact: true });
      else queryClient.setQueryData(key, data);
    }
    journal.observed = readTimeblockCache(queryClient);
  }
  settleTimeblockCache(queryClient, context);
}

interface TimeModelListFilter {
  ids?: string[];
  search?: string;
  activityId?: string;
  startDate?: string;
  endDate?: string;
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

function replayServerTimeModelRow(
  queryKey: QueryKey,
  data: unknown,
  lane: 'plans' | 'records',
  row: TimeModelListRow,
): unknown {
  const path = queryKey[0];
  if (!Array.isArray(path) || path[0] !== lane) return data;
  if (isLaneListQuery(lane)({ queryKey })) {
    const rows = cacheRows(data) ? data : [];
    const filter = getListFilter(queryKey);
    if (filter.search || ((filter.offset ?? 0) > 0 && !rows.some((value) => value.id === row.id)))
      return data;
    const without = rows.filter((value) => value.id !== row.id);
    return doesTimeModelListQueryIncludeRow(queryKey, row, lane, 'update')
      ? sortAndLimitRows([...without, row], queryKey, lane)
      : without;
  }
  return data && typeof data === 'object' && 'id' in data && data.id === row.id ? row : data;
}

/** DBが返した確定行を、現在保持している全list cacheへ反映する。 */
function replaceTimeModelRowInMatchingLists<T extends TimeModelListRow>(
  queryClient: QueryClient,
  lane: 'plans' | 'records',
  row: T,
  patchExisting?: (current: T) => T,
): void {
  const predicate = lane === 'plans' ? isPlansListQuery : isRecordsListQuery;
  for (const [queryKey, data] of queryClient.getQueriesData<T[]>({ predicate })) {
    const filter = getListFilter(queryKey);
    if (filter.search) continue;

    const old = data ?? [];
    const current = old.find((candidate) => candidate.id === row.id);
    const containsRow = current !== undefined;
    const nextRow = current && patchExisting ? patchExisting(current) : row;
    const shouldInclude = doesTimeModelListQueryIncludeRow(queryKey, nextRow, lane, 'update');

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
    queryClient.setQueryData(queryKey, sortAndLimitRows([...withoutRow, nextRow], queryKey, lane));
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
  journal: CacheJournal;
  operation: { failed: boolean };
  queries: ReturnType<ReturnType<QueryClient['getQueryCache']>['getAll']>;
  mutations: ReturnType<ReturnType<QueryClient['getMutationCache']>['getAll']>;
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
    if (isCancelledError(error)) return;
    toast.error(
      (getTimeblockServiceCode(error) === 'EXTERNAL_CALENDAR_ALREADY_CONVERTED'
        ? t('toast.externalCalendarAlreadyConverted')
        : undefined) ??
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
    // 現在の行を一度patchし、変更後に一致する一覧へ移す。
    // 既存の一覧だけをmapすると、activity/期間を変更した先のcacheに入らない。
    for (const [queryKey, data] of queryClient.getQueriesData<T[]>({ predicate })) {
      if (getListFilter(queryKey).search) continue;
      const current = data?.find((row) => row.id === id);
      if (!current) continue;
      replaceTimeModelRowInMatchingLists(queryClient, lane, patch(current), patch);
      return;
    }
  };

  const recordPatchIntent = <T extends TimeModelListRow>(
    context: MutationContext,
    lane: 'plans' | 'records',
    id: string,
    patch: (row: T) => T,
  ) => {
    for (const [queryKey] of readTimeblockCache(queryClient)) {
      const path = queryKey[0];
      if (!Array.isArray(path) || path[0] !== lane) continue;
      if (isLaneListQuery(lane)({ queryKey }) && getListFilter(queryKey).search) continue;
      context.journal.changes.push({
        queryKey,
        owner: context,
        apply: (data) => {
          if (cacheRows(data)) return data.map((row) => (row.id === id ? patch(row as T) : row));
          if (data && typeof data === 'object' && 'id' in data && data.id === id)
            return patch(data as T);
          return data;
        },
      });
    }
  };

  // getById も対象に含めて router 全体を再検証する（Inspector の updated_at 鮮度を保つ）
  const invalidate = () => {
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const path = query.queryKey[0];
        return Array.isArray(path) && (path[0] === 'statistics' || path[0] === 'review');
      },
    });
    void utils.plans.invalidate();
    void utils.records.invalidate();
  };

  const settleAndInvalidate = (
    _data: unknown,
    _error: unknown,
    _input: unknown,
    context: MutationContext | undefined,
  ) => {
    const current = isTimeblockCacheCurrent(queryClient, context);
    settleTimeblockCache(queryClient, context);
    if (current) invalidate();
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
        source: 'manual',
        deleted_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      writeTimeblockCache(queryClient, context, () => insertIntoMatchingLists('plans', tempPlan));
      return { ...context, tempId };
    },
    onSuccess: (created, _input, context) => {
      if (!created) return;
      if (!context) return;
      writeTimeblockCache(queryClient, context, () => {
        insertIntoMatchingLists('plans', created, context.tempId);
        utils.plans.getById.setData({ id: created.id }, created);
      });
    },
    onError: (error, _input, context) => {
      restore(context);
      reportCreateError(error);
    },
    onSettled: settleAndInvalidate,
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
      writeTimeblockCache(queryClient, context, () =>
        insertIntoMatchingLists('records', tempRecord),
      );
      return { ...context, tempId };
    },
    onSuccess: (created, _input, context) => {
      if (!created) return;
      if (!context) return;
      writeTimeblockCache(queryClient, context, () => {
        insertIntoMatchingLists('records', created, context.tempId);
        utils.records.getById.setData({ id: created.id }, created);
      });
    },
    onError: (error, _input, context) => {
      restore(context);
      reportCreateError(error);
    },
    onSettled: settleAndInvalidate,
  });

  const updatePlan = api.planCommands.update.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const patch = (row: PlanListItem): PlanListItem => ({
        ...row,
        ...(input.data.title !== undefined ? { title: input.data.title } : {}),
        ...(input.data.note !== undefined ? { note: input.data.note ?? null } : {}),
        ...(input.data.activityId !== undefined ? { activity_id: input.data.activityId } : {}),
        ...(input.data.start_at !== undefined ? { start_at: input.data.start_at } : {}),
        ...(input.data.end_at !== undefined ? { end_at: input.data.end_at } : {}),
      });
      writeTimeblockCache(queryClient, context, () => {
        recordPatchIntent(context, 'plans', input.id, patch);
        patchMatchingLists('plans', input.id, patch);
        utils.plans.getById.setData({ id: input.id }, (old) => (old ? patch(old) : old));
      });
      return context;
    },
    onSuccess: (updated, _input, context) => {
      if (!context) return;
      writeTimeblockCache(
        queryClient,
        context,
        () => {
          replaceServerRow('plans', updated);
          utils.plans.getById.setData({ id: updated.id }, updated);
        },
        (key, data) => replayServerTimeModelRow(key, data, 'plans', updated),
      );
    },
    onError: (error, input, context) => {
      restore(context);
      reportUpdateError(error, input);
    },
    onSettled: settleAndInvalidate,
  });

  const updateRecord = api.recordCommands.update.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      const patch = (row: RecordListItem): RecordListItem => ({
        ...row,
        ...(input.data.title !== undefined ? { title: input.data.title } : {}),
        ...(input.data.note !== undefined ? { note: input.data.note ?? null } : {}),
        ...(input.data.activityId !== undefined ? { activity_id: input.data.activityId } : {}),
        ...(input.data.start_at !== undefined ? { start_at: input.data.start_at } : {}),
        ...(input.data.end_at !== undefined ? { end_at: input.data.end_at } : {}),
        ...(input.data.fulfillment !== undefined ? { fulfillment: input.data.fulfillment } : {}),
      });
      writeTimeblockCache(queryClient, context, () => {
        recordPatchIntent(context, 'records', input.id, patch);
        patchMatchingLists('records', input.id, patch);
        utils.records.getById.setData({ id: input.id }, (old) => (old ? patch(old) : old));
      });
      return context;
    },
    onSuccess: (updated, _input, context) => {
      if (!context) return;
      writeTimeblockCache(
        queryClient,
        context,
        () => {
          replaceServerRow('records', updated);
          utils.records.getById.setData({ id: updated.id }, updated);
        },
        (key, data) => replayServerTimeModelRow(key, data, 'records', updated),
      );
    },
    onError: (error, input, context) => {
      restore(context);
      reportUpdateError(error, input);
    },
    onSettled: settleAndInvalidate,
  });

  const reportDeleteError = () => toast.error(t('toast.deleteFailed'));
  const reportRestoreError = (error: unknown) =>
    toast.error(
      getTimeblockServiceCode(error) === 'EXTERNAL_CALENDAR_ALREADY_CONVERTED'
        ? t('toast.externalCalendarRestoreConflict')
        : getTimeblockServiceCode(error) === 'TIME_OVERLAP'
          ? t('toast.overlap')
          : t('toast.restoreFailed'),
    );

  const deletePlan = api.planCommands.delete.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      deleteTimeblockCacheRows(queryClient, context, 'plans', new Set([input.id]));
      writeTimeblockCache(queryClient, context, () =>
        utils.plans.getById.setData({ id: input.id }, undefined),
      );
      return context;
    },
    onError: (_error, _input, context) => {
      restore(context);
      if (isCancelledError(_error)) return;
      reportDeleteError();
    },
    onSettled: settleAndInvalidate,
  });

  const deleteRecord = api.recordCommands.delete.useMutation({
    retry: false,
    onMutate: async (input): Promise<MutationContext> => {
      const context = await snapshot();
      deleteTimeblockCacheRows(queryClient, context, 'records', new Set([input.id]));
      writeTimeblockCache(queryClient, context, () =>
        utils.records.getById.setData({ id: input.id }, undefined),
      );
      return context;
    },
    onError: (_error, _input, context) => {
      restore(context);
      if (isCancelledError(_error)) return;
      reportDeleteError();
    },
    onSettled: settleAndInvalidate,
  });

  const restorePlan = api.planCommands.restore.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (restored, _input, context) => {
      if (!context) return;
      writeTimeblockCache(queryClient, context, () => {
        insertIntoMatchingLists('plans', restored);
        utils.plans.getById.setData({ id: restored.id }, restored);
      });
    },
    onError: (error, _input, context) => {
      restore(context);
      if (isCancelledError(error)) return;
      reportRestoreError(error);
    },
    onSettled: settleAndInvalidate,
  });

  const restoreRecord = api.recordCommands.restore.useMutation({
    retry: false,
    onMutate: snapshot,
    onSuccess: (restored, _input, context) => {
      if (!context) return;
      writeTimeblockCache(queryClient, context, () => {
        insertIntoMatchingLists('records', restored);
        utils.records.getById.setData({ id: restored.id }, restored);
      });
    },
    onError: (error, _input, context) => {
      restore(context);
      if (isCancelledError(error)) return;
      reportRestoreError(error);
    },
    onSettled: settleAndInvalidate,
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
    updateRecord,
    updatePlan,
  };
}
