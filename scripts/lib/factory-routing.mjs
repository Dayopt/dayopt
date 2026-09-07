import { resolveProtectedPathGate } from '../ci/protected-path-gate.mjs';

/**
 * Advisory routing only: never a permission, readiness label, or model launcher.
 * @param {{files: string[] | null, labels?: string[], body?: string,
 * acceptance?: boolean, verification?: boolean, metadataAvailable?: boolean,
 * state?: string | null}} input
 */
export function resolveFactoryRoute({
  files,
  labels = [],
  body = '',
  acceptance = false,
  verification = false,
  metadataAvailable = false,
  state = null,
}) {
  const paths = Array.isArray(files)
    ? files.map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''))
    : [];
  const missing = [];
  if (!metadataAvailable) missing.push('元の issue / PR 情報');
  if (paths.length === 0) missing.push('対象パス');
  if (!acceptance) missing.push('受け入れ条件');
  if (!verification) missing.push('検証コマンド');
  const reasons = [];
  // An issue may name a directory rather than an existing file.
  const protectedGate = resolveProtectedPathGate(
    paths.flatMap((path) => [path, `${path}/__scope__`]),
  );
  if (protectedGate.required) reasons.push(`外部契約・不可逆領域: ${protectedGate.reason}`);
  // Time contracts are intentionally outside the protected-path merge signal.
  if (
    paths.some((path) =>
      /^apps\/product\/src\/(?:lib\/time|features\/(?:timeblock|calendar))(?:\/|$)/.test(path),
    ) ||
    /timezone|\bDST\b|半開区間|時間不変条件|時刻の規則|overlap|temporal/i.test(body)
  ) {
    reasons.push('時間・操作の不変条件に関係する可能性');
  }
  if (labels.some((label) => ['risk:authority', 'type:spike'].includes(label))) {
    reasons.push('設計・権限・詳細レビューの明示指定');
  }
  if (/認可|権限境界|課金|不可逆|\b(?:RLS|OAuth|SECURITY DEFINER)\b/i.test(body)) {
    reasons.push('本文に権限・外部契約・不可逆性の手掛かり');
  }
  const unavailable = labels.includes('status:blocked') || state?.toLowerCase() !== 'open';
  if (unavailable) missing.push('OPEN かつ凍結されていない状態');
  const level = reasons.length > 0 ? 'L3' : missing.length > 0 ? 'unclassified' : 'L2';
  return {
    version: 1,
    advisory: true,
    level,
    ready: missing.length === 0,
    reasons:
      reasons.length > 0
        ? reasons
        : [level === 'L2' ? '通常実装の暫定候補' : '情報不足のため未分類'],
    missing,
    preparation: paths.length > 0 ? 'L1' : 'L0',
    // L1 describes preparation, not automatic authorization for implementation.
    preparationGoal:
      paths.length > 0
        ? '指定範囲の事実・根拠・既存パターン・未確認事項を引き継ぐ'
        : '対象パスと完了条件を収集する',
  };
}
