/**
 * Calendar の時刻精度ポリシー
 *
 * ドラッグ系（作成 / 移動 / リサイズ / 選択ハイライト）は 15 分刻み、
 * Inspector / text input は 1 分刻みという非対称を正とする。
 * 粗い操作で素早くキリの良い時刻へ置き、細かい調整は Inspector が担う。
 *
 * #2496 で全操作を 1 分へ統一したが、hourHeight 72px では 1px ≒ 0.83 分となり
 * ドラッグが事実上ピクセル精度になって「10:00 に置く」だけで手が要るため、
 * ドラッグ側だけ 15 分へ戻した（2026-09-10）。
 *
 * 1 分粒度を失わないための不変条件:
 * - 既存ブロックの移動・リサイズは**相対 snap**（移動量だけを 15 分刻みに量子化し、
 *   元の分を保持する）。10:07 のブロックを 1 マス下げると 10:22 になり、
 *   10:15 へ吸着しない。Inspector で入れた分をドラッグが丸めない
 * - リサイズは開始時刻を動かさない（終端だけを相対 snap する）
 * - 新規作成だけは絶対 snap でよい（:00 / :15 / :30 / :45 に揃う）
 *
 * snap 粒度と最小ブロック長は独立した概念として分離する:
 * - snap 粒度 15 分 = 時刻の「位置」をどこに置けるか
 * - 最小ブロック長 5 分 = ブロックの「長さ」の下限（誤操作での極小ブロック防止）
 */

/** Inspector / text input 専用の入力精度。ドラッグ側とは独立に 1 分を保つ。 */
export const INSPECTOR_TIME_PRECISION_MINUTES = 1;

/** drag / resize / tap の snap 粒度。移動・リサイズでは「移動量」に対して適用する。 */
export const DEFAULT_DRAG_SNAP_MINUTES = 15;

/** drag / resize で作成・変更できるブロック長の下限。snap 粒度とは独立。 */
export const MIN_TIMEBLOCK_DURATION_MINUTES = 5;

/**
 * ハプティック発火の境界間隔。
 *
 * 相対 snap では 1 分刻みの時刻（10:07 → 10:22）を跨ぐため「snap 変化ごとに発火」
 * だと粒度が読めない。5 分境界を跨いだ時だけ発火させる。
 */
export const HAPTIC_BOUNDARY_MINUTES = 5;

/** prev → next の移動が HAPTIC_BOUNDARY_MINUTES 境界を跨いだか（分単位で比較）。 */
export function crossedHapticBoundary(prevMinutes: number, nextMinutes: number): boolean {
  if (prevMinutes === nextMinutes) return false;
  return (
    Math.floor(prevMinutes / HAPTIC_BOUNDARY_MINUTES) !==
    Math.floor(nextMinutes / HAPTIC_BOUNDARY_MINUTES)
  );
}
