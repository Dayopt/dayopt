import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

const USER_ID = 'user-1';

export interface MirrorRow {
  id: string;
  user_id: string;
  status: string;
  dismissed_at: string | null;
  connection_id: string | null;
  provider_calendar_id: string;
  title: string | null;
  calendar_name: string | null;
  start_at: string | null;
  end_at: string | null;
}

interface ReferenceRow {
  user_id: string;
  external_calendar_event_id: string | null;
  deleted_at: string | null;
}

interface SelectedCalendarRow {
  user_id: string;
  connection_id: string;
  provider_calendar_id: string;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  status: string;
}

export function mirrorRow(overrides: Partial<MirrorRow> & { id: string }): MirrorRow {
  return {
    user_id: USER_ID,
    status: 'confirmed',
    dismissed_at: null,
    connection_id: 'connection-1',
    provider_calendar_id: 'calendar-1',
    title: 'Standup',
    calendar_name: 'Work',
    start_at: '2026-08-11T09:00:00.000Z',
    end_at: '2026-08-11T09:30:00.000Z',
    ...overrides,
  };
}

/** `events` に出てくる `(connection_id, provider_calendar_id)` を「現在も選択中」として自動導出する。 */
function selectionFromEvents(events: MirrorRow[]): SelectedCalendarRow[] {
  const seen = new Set<string>();
  const rows: SelectedCalendarRow[] = [];

  for (const row of events) {
    if (row.connection_id === null) continue;
    const key = `${row.user_id} ${row.connection_id} ${row.provider_calendar_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      user_id: row.user_id,
      connection_id: row.connection_id,
      provider_calendar_id: row.provider_calendar_id,
    });
  }

  return rows;
}

/** `events` に出てくる `connection_id` を「すべて active」として自動導出する。 */
function activeConnectionsFromEvents(events: MirrorRow[]): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];

  for (const row of events) {
    if (row.connection_id === null) continue;
    const key = `${row.user_id} ${row.connection_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: row.connection_id, user_id: row.user_id, status: 'active' });
  }

  return rows;
}

/**
 * `.in()` / `.is()` / `.gt()` などを実際に適用する最小の fake table。
 *
 * `createChainableMock` は 1 種類の結果しか返せないため、events → plans → records の 3 クエリを
 * 撃つこの service の導出条件（とくに soft-delete の扱いとページング）を検証できない。ここで
 * assert したいのは「どのメソッドを呼んだか」ではなく「どの行が残るか」なので、フィルタを
 * 実際に効かせる。
 */
function createFakeTable<T extends object>(rows: T[]) {
  const valueOf = (row: T, column: string): unknown => (row as Record<string, unknown>)[column];
  const calls: Array<[string, ...unknown[]]> = [];
  let result = [...rows];

  const record = (name: string, ...args: unknown[]) => {
    calls.push([name, ...args]);
  };

  const api = {
    calls,
    select: vi.fn((..._args: unknown[]) => api),
    eq: vi.fn((column: string, value: unknown) => {
      record('eq', column, value);
      result = result.filter((row) => valueOf(row, column) === value);
      return api;
    }),
    is: vi.fn((column: string, value: unknown) => {
      record('is', column, value);
      result = result.filter((row) => valueOf(row, column) === value);
      return api;
    }),
    not: vi.fn((column: string, operator: string, value: unknown) => {
      record('not', column, operator, value);
      result = result.filter((row) => valueOf(row, column) !== value);
      return api;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      record('in', column, values);
      result = result.filter((row) => values.includes(valueOf(row, column)));
      return api;
    }),
    lt: vi.fn((column: string, value: string) => {
      record('lt', column, value);
      result = result.filter(
        (row) => typeof valueOf(row, column) === 'string' && String(valueOf(row, column)) < value,
      );
      return api;
    }),
    gt: vi.fn((column: string, value: string) => {
      record('gt', column, value);
      result = result.filter(
        (row) => typeof valueOf(row, column) === 'string' && String(valueOf(row, column)) > value,
      );
      return api;
    }),
    order: vi.fn((column: string, options?: { ascending?: boolean }) => {
      record('order', column, options);
      const direction = options?.ascending === false ? -1 : 1;
      result = [...result].sort(
        (a, b) => String(valueOf(a, column)).localeCompare(String(valueOf(b, column))) * direction,
      );
      return api;
    }),
    limit: vi.fn((count: number) => {
      record('limit', count);
      result = result.slice(0, count);
      return api;
    }),
    then: (resolve: (value: { data: T[]; error: null }) => unknown) =>
      Promise.resolve(resolve({ data: result, error: null })),
  };

  return api;
}

export function createSupabase(options: {
  events: MirrorRow[];
  plans?: ReferenceRow[];
  records?: ReferenceRow[];
  /** 省略時は `events` に出てくる組を全て「選択中」として扱う（既存テストの前提を変えない）。 */
  selectedCalendars?: SelectedCalendarRow[];
  /** 省略時は `events` に出てくる connection_id を全て active として扱う（既存テストの前提を変えない）。 */
  connections?: ConnectionRow[];
}) {
  const eventTables: ReturnType<typeof createFakeTable<MirrorRow>>[] = [];
  const referenceTables: ReturnType<typeof createFakeTable<ReferenceRow>>[] = [];
  const selectionTables: ReturnType<typeof createFakeTable<SelectedCalendarRow>>[] = [];
  const connectionTables: ReturnType<typeof createFakeTable<ConnectionRow>>[] = [];
  const selectedCalendars = options.selectedCalendars ?? selectionFromEvents(options.events);
  const connections = options.connections ?? activeConnectionsFromEvents(options.events);

  const from = vi.fn((table: string) => {
    if (table === 'external_calendar_events') {
      const fake = createFakeTable(options.events);
      eventTables.push(fake);
      return fake;
    }
    if (table === 'calendar_connection_calendars') {
      const fake = createFakeTable(selectedCalendars);
      selectionTables.push(fake);
      return fake;
    }
    if (table === 'calendar_connections') {
      const fake = createFakeTable(connections);
      connectionTables.push(fake);
      return fake;
    }
    const fake = createFakeTable(
      table === 'plans' ? (options.plans ?? []) : (options.records ?? []),
    );
    referenceTables.push(fake);
    return fake;
  });

  return {
    supabase: { from } as unknown as SupabaseClient<Database>,
    from,
    eventTables,
    referenceTables,
    selectionTables,
    connectionTables,
  };
}

export function reference(eventId: string, deletedAt: string | null = null): ReferenceRow {
  return { user_id: USER_ID, external_calendar_event_id: eventId, deleted_at: deletedAt };
}
