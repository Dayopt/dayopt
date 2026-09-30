export type TimeblockDestination = 'plan' | 'record';

/** 新規作成の既定の保存先を終了時刻から決める。種別の選択可否は resolveTimeblockKindChoice が担う。 */
export function resolveTimeblockDestination(
  endAt: Date | string,
  now: Date = new Date(),
): TimeblockDestination {
  return new Date(endAt).getTime() > now.getTime() ? 'plan' : 'record';
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
