export type TimeblockDestination = 'plan' | 'record';

/** 保存先はユーザー選択ではなく終了時刻だけから決める。 */
export function resolveTimeblockDestination(
  endAt: Date | string,
  now: Date = new Date(),
): TimeblockDestination {
  return new Date(endAt).getTime() > now.getTime() ? 'plan' : 'record';
}

/** Plan を Record レーンへ落とす操作は記録化として扱う。 */
export function isPlanRecordDrop(
  sourceLane: TimeblockDestination,
  targetLane: TimeblockDestination,
): boolean {
  return sourceLane === 'plan' && targetLane === 'record';
}

/**
 * 既定は {@link resolveTimeblockDestination} と同じ end_at 判定。
 * 過去スロット（end_at <= now）に限り、ユーザーが Plan / Record を選び直せる。
 * 未来へリサイズされた場合は要求に関わらず Plan へ倒すので DT005 に当たる経路は無い。
 *
 * @returns `kind` は実際に保存する種別、`canRecord` は「記録」を選べるか
 *   （Record は未来に終われない DT005 のため `end_at <= now` のときだけ true）
 */
export function resolveTimeblockKindChoice(
  endAt: Date | string,
  requested: TimeblockDestination | undefined,
  now: Date = new Date(),
): { kind: TimeblockDestination; canRecord: boolean } {
  const canRecord = resolveTimeblockDestination(endAt, now) === 'record';

  return {
    kind: canRecord ? (requested ?? 'record') : 'plan',
    canRecord,
  };
}
