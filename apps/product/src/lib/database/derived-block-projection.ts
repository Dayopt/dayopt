import type { DerivedBlock } from '@/lib/time';

/** DB/RPCのsnake_case行を、保存契約を持たない読み取りモデルへ変換する。 */
export function toDerivedBlock(
  row: {
    id: string;
    activity_id: string | null;
    start_at: string;
    end_at: string;
    note?: string | null;
    fulfillment?: string | null;
    source?: string;
  },
  kind: 'plan' | 'rec',
): DerivedBlock {
  const fulfillment = row.fulfillment;
  return {
    id: row.id,
    kind,
    activityId: row.activity_id,
    start: row.start_at,
    end: row.end_at,
    memo: row.note ?? null,
    fulfillment:
      fulfillment === 'low' || fulfillment === 'medium' || fulfillment === 'high'
        ? fulfillment
        : null,
    live: false,
    source: row.source ?? 'manual',
  };
}
