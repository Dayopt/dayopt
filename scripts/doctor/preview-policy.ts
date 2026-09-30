import {
  assertProductPreviewBuildEnv,
  FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV,
  REQUIRED_PRODUCT_PREVIEW_BUILD_ENV,
} from '../../apps/product/production-build-gate.mjs';
import type { Observation } from './types.ts';

type Row = Record<string, unknown>;
type BranchResult = {
  branch: string | null;
  status: 'pass' | 'drift' | 'blocked' | 'not_applicable';
  failures: string[];
  unreadable: string[];
};
const MARKERS = [
  'MCP_OAUTH_ENVIRONMENT',
  'MCP_OAUTH_PREVIEW_BRANCH',
  'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
];
const PRESENCE_ONLY = new Set([
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'RECOVERY_CODE_PEPPER',
]);
const SYSTEM_VALUES = new Set([
  'VERCEL_ENV',
  'VERCEL_TARGET_ENV',
  'VERCEL_BRANCH_URL',
  'VERCEL_GIT_COMMIT_REF',
]);
const SOURCE = 'apps/product/production-build-gate.mjs#assertProductPreviewBuildEnv';

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}
function records(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function preview(row: Row): boolean {
  return Array.isArray(row.target)
    ? row.target.includes('preview')
    : Array.isArray(row.targets) && row.targets.includes('preview');
}
function effective(rows: Row[], branch: string | null): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const scope of [null, ...(branch === null ? [] : [branch])]) {
    for (const row of rows) {
      if (!preview(row) || (row.gitBranch ?? null) !== scope || typeof row.key !== 'string')
        continue;
      result.set(row.key, row);
    }
  }
  return result;
}
function hasValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim() !== ''
    : Array.isArray(value)
      ? value.length > 0
      : value === true;
}

/** Apply the build contract only to explicitly enabled MCP OAuth Preview scopes. */
export function evaluatePreviewPolicy(observations: Observation[]): Observation {
  const base: Observation = {
    key: 'vercel.preview.mcp_build_policy',
    environment: 'preview',
    value: null,
    source: SOURCE,
    next_step:
      '明示MCP OAuth Previewの実deployment環境とpublic設定を取得して既存build契約に照合してください。',
  };
  const bindingsObservation = observations.find(
    (row) => row.key === 'vercel.product.public_bindings',
  );
  const metadataObservation = observations.find(
    (row) => row.key === 'vercel.product.environment_metadata',
  );
  if (
    !bindingsObservation ||
    !metadataObservation ||
    bindingsObservation.status ||
    metadataObservation.status ||
    !Array.isArray(bindingsObservation.value) ||
    !Array.isArray(record(metadataObservation.value).entries)
  ) {
    return {
      ...base,
      status: 'blocked',
      reason: 'Preview env metadataまたはpublic bindingsを取得できません。',
    };
  }
  const bindings = records(bindingsObservation.value).filter(preview);
  const metadata = records(record(metadataObservation.value).entries).filter(preview);
  const allRows = [...metadata, ...bindings];
  const scopes = new Set<string | null>([null]);
  for (const row of allRows) if (typeof row.gitBranch === 'string') scopes.add(row.gitBranch);
  const branches: BranchResult[] = [];
  for (const branch of scopes) {
    const values = effective(bindings, branch);
    const names = effective(metadata, branch);
    const markerPresent = MARKERS.some((key) => names.has(key) || values.has(key));
    const explicit =
      values.get('MCP_OAUTH_ENVIRONMENT')?.value === 'preview' ||
      MARKERS.slice(1).some((key) => hasValue(values.get(key)?.value));
    if (!explicit) {
      const unreadable = MARKERS.filter(
        (key) =>
          (names.has(key) || values.has(key)) &&
          (values.get(key)?.value === null || !values.has(key)),
      );
      branches.push({
        branch,
        status: markerPresent && unreadable.length ? 'blocked' : 'not_applicable',
        failures: [],
        unreadable,
      });
      continue;
    }
    const failures: string[] = [];
    const unreadable: string[] = [];
    const env: Record<string, string> = {};
    for (const [key, binding] of values) {
      if (typeof binding.value === 'string') env[key] = binding.value;
      else if (typeof binding.value === 'boolean' && !PRESENCE_ONLY.has(key))
        env[key] = String(binding.value);
    }
    if (env.MCP_OAUTH_ENVIRONMENT && env.MCP_OAUTH_ENVIRONMENT !== 'preview') {
      failures.push('mcp_oauth_environment_not_preview');
    }
    for (const key of FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV as string[]) {
      const binding = values.get(key);
      if (binding?.value === true || hasValue(binding?.value)) {
        failures.push(`forbidden_present:${key}`);
      } else if (names.has(key) && binding?.value !== false && binding?.value !== '') {
        unreadable.push(key);
      }
    }
    if (env.BILLING_ENFORCED === 'true') failures.push('billing_enforced_forbidden');
    if (hasValue(env.MCP_WRITE_ENABLED_CLIENTS)) failures.push('mcp_write_allowlist_forbidden');
    if (env.NEXT_PUBLIC_SUPABASE_URL) {
      try {
        if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname === 'yvglwblxrnrenfifsnje.supabase.co') {
          failures.push('production_supabase_reference');
        }
      } catch {
        failures.push('invalid_supabase_url');
      }
    }
    for (const key of REQUIRED_PRODUCT_PREVIEW_BUILD_ENV as string[]) {
      const binding = values.get(key);
      if (PRESENCE_ONLY.has(key)) {
        if (binding?.value === false) failures.push(`required_absent:${key}`);
        else if (binding?.value === true || names.has(key))
          env[key] = 'doctor-presence-placeholder';
        else failures.push(`required_absent:${key}`);
      } else if (!hasValue(env[key])) {
        if (names.has(key) || values.has(key) || SYSTEM_VALUES.has(key)) unreadable.push(key);
        else failures.push(`required_absent:${key}`);
      }
    }
    // System env values are deployment evidence. Do not synthesize branchURL or target from configured env scopes.
    for (const key of ['VERCEL_ENV', 'VERCEL_TARGET_ENV']) {
      if (!hasValue(env[key])) unreadable.push(key);
    }
    const known = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'].filter(
      (key) => env[key] && env[key] !== 'preview',
    );
    for (const key of known) failures.push(`not_standard_preview:${key}`);
    if (
      env.MCP_OAUTH_PREVIEW_BRANCH &&
      env.VERCEL_GIT_COMMIT_REF &&
      env.MCP_OAUTH_PREVIEW_BRANCH !== env.VERCEL_GIT_COMMIT_REF
    )
      failures.push('preview_branch_mismatch');
    let status: BranchResult['status'];
    if (failures.length) status = 'drift';
    else if (unreadable.length) status = 'blocked';
    else {
      try {
        status = assertProductPreviewBuildEnv(env) === true ? 'pass' : 'not_applicable';
      } catch {
        // The build gate errors contain fixed contract text. Do not emit any thrown value.
        failures.push('existing_preview_build_contract_rejected');
        status = 'drift';
      }
    }
    branches.push({ branch, status, failures, unreadable: [...new Set(unreadable)] });
  }
  const drift = branches.some((row) => row.status === 'drift');
  const blocked = branches.some((row) => row.status === 'blocked');
  const applicable = branches.some((row) => row.status === 'pass');
  const value = { passed: drift ? false : blocked ? null : applicable ? true : null, branches };
  if (drift)
    return {
      ...base,
      value,
      reason:
        '明示MCP OAuth Previewに既存build契約との既知差異があります。未取得値は別途明記します。',
    };
  if (blocked)
    return {
      ...base,
      value,
      status: 'blocked',
      reason: '明示MCP OAuth Previewの必須public値またはmarkerを読めず、契約一致を証明できません。',
    };
  if (!applicable)
    return {
      ...base,
      value,
      status: 'not_applicable',
      reason: '取得した一般Preview/Integrationには明示MCP OAuth Preview markerがありません。',
    };
  return {
    ...base,
    value,
    reason:
      '秘密は存在placeholderだけを使い、取得済みpublic値を既存Preview build契約に照合しました。実通信やcredential有効性の証明ではありません。',
  };
}
