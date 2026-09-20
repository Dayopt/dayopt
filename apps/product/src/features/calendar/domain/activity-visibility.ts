/** 未初期化は「選択なし」でなく既定の全表示。SSR と最初の hydration は同じ値を使う。 */
export function isActivityVisible(
  activityId: string | null,
  initialized: boolean,
  visibleActivityIds: ReadonlySet<string>,
): boolean {
  return !initialized || activityId === null || visibleActivityIds.has(activityId);
}
