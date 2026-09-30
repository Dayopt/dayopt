import type { Observation } from './types.ts';
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : [];
/** An inaccessible branch is not proof that it was deleted. */
export function previewReferences(observations: Observation[]): Observation {
  const binding = observations.find((entry) => entry.key === 'vercel.product.public_bindings');
  const branches = observations.find((entry) => entry.key === 'supabase.branches');
  const base = {
    key: 'vercel.preview.database_references',
    environment: 'preview',
    source: 'vercel.binding + supabase.branches',
  };
  if (!binding || binding.status || !branches || branches.status)
    return {
      ...base,
      value: null,
      status: 'blocked',
      reason: 'cross_service_evidence_missing',
      next_step:
        '全サービス、またはVercelとSupabaseの両metadataを取得。片方だけではbranchの存在を判定しません。',
    };
  const available = new Set(objects(branches.value).map((entry) => entry.project_ref));
  const refs = objects(binding.value)
    .filter(
      (entry) =>
        entry.key === 'NEXT_PUBLIC_SUPABASE_URL' &&
        Array.isArray(entry.target) &&
        entry.target.includes('preview'),
    )
    .map((entry) => {
      let ref: string | null = null;
      if (typeof entry.value === 'string') {
        try {
          const host = new URL(entry.value).hostname;
          if (/^[a-z]{20}\.supabase\.co$/.test(host)) ref = host.split('.')[0];
        } catch {
          /* unknown */
        }
      }
      return {
        branch: entry.gitBranch ?? 'default_preview',
        project_ref: ref,
        accessible_branch_list_match: ref !== null && available.has(ref),
      };
    });
  const uncertain = refs.some((entry) => !entry.accessible_branch_list_match);
  return {
    ...base,
    value: refs,
    ...(uncertain
      ? {
          status: 'blocked' as const,
          reason: 'preview_ref_not_in_accessible_branch_list',
          next_step: '該当branch/refの既存リソースとアクセス範囲を確認。削除済みとは断定しません。',
        }
      : {}),
  };
}
