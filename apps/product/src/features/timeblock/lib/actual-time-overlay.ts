/**
 * 予定 vs 記録の差分表示ヘルパー。
 *
 * 差分の px オーバーレイ計算（`computeActualTimeDiffOverlay`）は、1 件が予定と実績の
 * 両方の時刻を持っていた旧 entries 統合モデル専用だったため 2026-09-16 に撤去した。
 * Plan / Record 分離モデルでは 1 件が持つ時刻は 1 組だけで、差分は Plan と Record の
 * 対応関係から導出する（`features/timeblock/lib/time-diff.ts`）。
 */

/** 差分の分数を Xmin / XhYm 形式にフォーマット（符号なし） */
export function formatDiffMinutes(minutes: number): string {
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}
