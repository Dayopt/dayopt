import { ciSecretSchema } from '../tasks/env/schema.ts';
import type { Definition, Observation, Result } from './types.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
export const RULES = [
  'evidence',
  'manual',
  'subset',
  'contract_errors',
  'passed',
  'ruleset',
  'ci_secrets',
  'bindings',
  'domains',
  'stripe_account',
  'stripe_prices',
  'stripe_webhooks',
  'resend_webhooks',
  'database',
] as const;
function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.every((entry) => actual.some((value) => subset(entry, value)))
    );
  if (expected && typeof expected === 'object')
    return Object.entries(expected).every(([key, value]) => subset(value, object(actual)[key]));
  return expected === actual;
}
function applies(pattern: string) {
  if (['~DEFAULT_BRANCH', '~ALL'].includes(pattern)) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test('refs/heads/main');
}
export function evaluate(
  definition: Definition,
  observation: Observation,
): { status: Result['status']; reason: string } {
  if (observation.status)
    return { status: observation.status, reason: observation.reason ?? observation.status };
  const value = observation.value;
  const actual = object(value);
  const expected = object(definition.expected);
  let matches = false;
  switch (definition.rule) {
    case 'manual':
      return { status: 'manual', reason: 'API metadataだけではこの期待値を証明できません。' };
    case 'evidence':
      return value === null || value === undefined
        ? { status: 'blocked', reason: 'metadata_missing' }
        : { status: 'pass', reason: '安全なmetadataの取得済み。動作成功の証明ではありません。' };
    case 'subset':
      matches = subset(definition.expected, value);
      break;
    case 'contract_errors':
      if (!Array.isArray(actual.contract_errors))
        return { status: 'blocked', reason: 'contract_result_missing' };
      matches = actual.contract_errors.length === 0;
      break;
    case 'passed':
      if (typeof actual.passed !== 'boolean')
        return { status: 'blocked', reason: 'contract_result_missing' };
      matches = actual.passed;
      break;
    case 'ruleset': {
      const active = objects(value).filter(
        (entry) =>
          entry.target === 'branch' &&
          entry.enforcement === 'active' &&
          Array.isArray(entry.includes) &&
          entry.includes.some((part) => typeof part === 'string' && applies(part)) &&
          !(
            Array.isArray(entry.excludes) &&
            entry.excludes.some((part) => typeof part === 'string' && applies(part))
          ),
      );
      const rules = active.flatMap((entry) => objects(entry.rules));
      const checks = rules.filter((entry) => entry.type === 'required_status_checks');
      const names = checks.flatMap((entry) =>
        objects(entry.required_checks).map((check) => check.context),
      );
      matches =
        active.length > 0 &&
        active.every(
          (entry) => Array.isArray(entry.bypass_actors) && entry.bypass_actors.length === 0,
        ) &&
        checks.some((entry) => entry.strict_required_checks === true) &&
        Array.isArray(expected.required_checks) &&
        expected.required_checks.every((name) => names.includes(name)) &&
        rules.some(
          (entry) =>
            entry.type === 'required_review_thread_resolution' ||
            entry.require_thread_resolution === true,
        );
      break;
    }
    case 'ci_secrets': {
      const name = definition.id.split('.')[1];
      const required = ciSecretSchema
        .filter((entry) => entry.githubEnvironments?.includes(name))
        .map((entry) => entry.githubSecret ?? entry.envName);
      matches = Array.isArray(value) && required.every((key) => value.includes(key));
      break;
    }
    case 'domains':
      matches = subset(
        expected.names,
        objects(value).map((entry) => entry.name),
      );
      break;
    case 'bindings':
      return evaluateBindings(objects(value), {
        ...expected,
        selected_environment: observation.environment,
      });
    case 'stripe_account':
      matches = actual.id === expected[observation.environment];
      break;
    case 'stripe_prices':
      if (observation.environment === 'production')
        return {
          status: 'pass',
          reason: 'Live価格metadataを取得。有効化待ちのため個数を期待値に固定しません。',
        };
      matches = objects(value).some((entry) => subset(expected, entry));
      break;
    case 'stripe_webhooks':
      if (observation.environment === 'production')
        return {
          status: 'pass',
          reason: 'Live webhook metadataを取得。Production有効化待ちのため配信成功は未検証。',
        };
      matches = objects(value).some((entry) => subset(expected, entry));
      break;
    case 'resend_webhooks':
      if (objects(value).some((entry) => entry.events === null))
        return { status: 'blocked', reason: 'webhook_events_not_returned' };
      matches =
        Array.isArray(definition.expected) &&
        definition.expected.every((entry) =>
          objects(value).some((candidate) => subset(entry, candidate)),
        );
      break;
    case 'database': {
      const metadata = objects(value)[0];
      if (!metadata) return { status: 'blocked', reason: 'database_metadata_missing' };
      matches = metadata.storage_rls_enabled === true;
      if (observation.environment === 'production')
        matches = matches && subset(expected.mcp_control, metadata.mcp_control);
      break;
    }
    default:
      throw new Error('Unknown doctor comparison rule');
  }
  return {
    status: matches ? 'pass' : 'drift',
    reason: matches ? '指定した期待値と一致' : '指定した期待値と差異。設定は変更していません。',
  };
}
export function evaluateBindings(
  bindings: Record<string, unknown>[],
  expected: Record<string, unknown>,
) {
  const failures: string[] = [];
  const missing: string[] = [];
  const dbs = bindings.filter((entry) => entry.key === 'NEXT_PUBLIC_SUPABASE_URL');
  const productionRef = String(expected.production_ref);
  if (
    expected.require_production_db !== false &&
    ['all', 'production'].includes(String(expected.selected_environment ?? 'all')) &&
    !dbs.some((entry) => Array.isArray(entry.target) && entry.target.includes('production'))
  )
    missing.push('production_database');
  for (const binding of dbs) {
    if (typeof binding.value !== 'string') {
      missing.push('sensitive_database_binding');
      continue;
    }
    const ref = (() => {
      try {
        return new URL(String(binding.value)).hostname.split('.')[0];
      } catch {
        return '';
      }
    })();
    if (
      Array.isArray(binding.target) &&
      binding.target.includes('production') &&
      ref !== productionRef
    )
      failures.push('production_database_mismatch');
    if (
      Array.isArray(binding.target) &&
      binding.target.includes('preview') &&
      ref === productionRef
    )
      failures.push('production_database_in_preview');
  }
  const scopes = ['production', 'preview'];
  for (const scope of scopes)
    for (const branch of new Set(
      bindings
        .filter((entry) => Array.isArray(entry.target) && entry.target.includes(scope))
        .map((entry) => String(entry.gitBranch ?? '')),
    )) {
      const effective = (key: string) =>
        bindings.find(
          (entry) =>
            entry.key === key &&
            String(entry.gitBranch ?? '') === branch &&
            Array.isArray(entry.target) &&
            entry.target.includes(scope),
        ) ??
        bindings.find(
          (entry) =>
            entry.key === key &&
            !entry.gitBranch &&
            Array.isArray(entry.target) &&
            entry.target.includes(scope),
        );
      const get = (key: string) => effective(key)?.value;
      if (
        expected.require_posthog_deletion !== false &&
        (get('POSTHOG_SERVER_ENABLED') === true ||
          get('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED') === true)
      ) {
        if (get('POSTHOG_PERSONAL_API_KEY') !== true)
          failures.push('posthog_enabled_without_deletion_key');
      }
      if (branch === 'integration' && get('BILLING_ENFORCED') === true) {
        if (get('STRIPE_LIVEMODE') == null || get('STRIPE_ACCOUNT_ID') == null)
          missing.push('integration_stripe_sensitive_identity');
        else if (
          get('STRIPE_LIVEMODE') !== false ||
          get('STRIPE_ACCOUNT_ID') !== expected.test_account
        )
          failures.push('integration_stripe_mode_or_account_mismatch');
        if (get('STRIPE_SECRET_KEY') !== true || get('STRIPE_WEBHOOK_SECRET') !== true)
          failures.push('integration_stripe_credential_missing');
      }
      if (effective('GOOGLE_CALENDAR_CLIENT_ID') && get('CALENDAR_TOKEN_ENCRYPTION_KEY') !== true)
        failures.push('calendar_encryption_key_missing');
    }
  if (failures.length)
    return { status: 'drift' as const, reason: [...new Set(failures)].join(', ') };
  if (missing.length)
    return { status: 'blocked' as const, reason: [...new Set(missing)].join(', ') };
  return {
    status: 'pass' as const,
    reason: '取得可能な接続先と条件付きcredential存在を確認。secret値の一致は未検証。',
  };
}
export function compare(
  definition: Definition,
  observation: Observation,
  now = new Date(),
): Result {
  return {
    check_id: `${definition.id}:${observation.environment}`,
    service: definition.service,
    environment: observation.environment,
    expected: definition.expected ?? definition.rule,
    observed: observation.value,
    source: observation.source,
    checked_at: now.toISOString(),
    ...evaluate(definition, observation),
    next_step: observation.next_step ?? definition.next_step,
    required: definition.required,
  };
}
