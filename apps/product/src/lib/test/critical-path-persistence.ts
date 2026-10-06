import { expect } from '@playwright/test';

import type { AdminSupabase } from './e2e/critical-path-fixture';

/** Reload cards alone cannot prove the selected kind or exact persisted interval. */
export async function expectIndependentPersistedHour(
  admin: AdminSupabase,
  userId: string,
  kind: 'plan' | 'record',
  dateParam: string,
  hour: number,
) {
  const start = new Date(`${dateParam}T${String(hour).padStart(2, '0')}:00:00+09:00`).toISOString();
  const end = new Date(
    `${dateParam}T${String(hour + 1).padStart(2, '0')}:00:00+09:00`,
  ).toISOString();
  const [selected, opposite] = await Promise.all([
    admin
      .from(kind === 'plan' ? 'plans' : 'records')
      .select('start_at,end_at')
      .eq('user_id', userId)
      .eq('start_at', start),
    admin
      .from(kind === 'plan' ? 'records' : 'plans')
      .select('start_at')
      .eq('user_id', userId)
      .eq('start_at', start),
  ]);
  expect(selected.error === null, 'Persisted interval query must succeed').toBe(true);
  expect(opposite.error === null, 'Opposite-kind query must succeed').toBe(true);
  expect(selected.data, 'Exactly one created interval must persist').toHaveLength(1);
  expect(new Date(selected.data![0]!.start_at!).toISOString()).toBe(start);
  expect(new Date(selected.data![0]!.end_at!).toISOString()).toBe(end);
  expect(
    opposite.data,
    'Creating one kind must not silently create the opposite kind',
  ).toHaveLength(0);
}
