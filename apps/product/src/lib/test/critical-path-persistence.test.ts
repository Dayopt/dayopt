import { describe, expect, it } from 'vitest';
import { type AdminSupabase, expectIndependentPersistedHour } from './e2e/critical-path-fixture';

const interval = { start_at: '2026-09-10T00:00:00+00:00', end_at: '2026-09-10T01:00:00+00:00' };

function database(planRows: (typeof interval)[], recordRows: (typeof interval)[]) {
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    from(table: string) {
      return {
        data: table === 'plans' ? planRows : recordRows,
        error: null,
        select() {
          return this;
        },
        eq(field: string, value: unknown) {
          filters.push([table, field, value]);
          return this;
        },
      };
    },
  } as unknown as AdminSupabase;
  return { client, filters };
}

describe('critical path persisted-kind assertion contract', () => {
  it('accepts the known hour only in the chosen kind and scopes both queries to its owner', async () => {
    const { client, filters } = database([interval], []);
    await expectIndependentPersistedHour(client, 'owned-synthetic-user', 'plan', '2026-09-10', 9);
    expect(filters).toContainEqual(['plans', 'user_id', 'owned-synthetic-user']);
    expect(filters).toContainEqual(['records', 'user_id', 'owned-synthetic-user']);
    expect(filters).toContainEqual(['plans', 'start_at', '2026-09-10T00:00:00.000Z']);
  });

  it('fails when a visible persisted card has the wrong duration, a duplicate, or an implicit opposite row', async () => {
    for (const [plans, records] of [
      [[{ ...interval, end_at: '2026-09-10T00:20:00+00:00' }], []],
      [[interval, interval], []],
      [[interval], [interval]],
    ] as Array<[(typeof interval)[], (typeof interval)[]]>) {
      const { client } = database(plans, records);
      await expect(
        expectIndependentPersistedHour(client, 'owned-synthetic-user', 'plan', '2026-09-10', 9),
      ).rejects.toThrow();
    }
  });
});
