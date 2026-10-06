import type { loadConfig } from './config.ts';
import { itemLocations } from './item-locations.ts';
import { sanitize } from './safety.ts';
import type { Environment } from './types.ts';

type Config = ReturnType<typeof loadConfig>;
type Selection = { service?: string; environment: Environment };
const inScope = (scopes: string[], environment: Environment) =>
  environment === 'all' || scopes.some((scope) => ['all', 'shared', environment].includes(scope));

/** This describes declared coverage, never the current health of any provider. */
export function designCoverage(config: Config, selection: Selection) {
  const checks = config.checks.filter(
    (check) =>
      (!selection.service || check.service === selection.service) &&
      inScope(check.environments, selection.environment),
  );
  const services = [...new Set(checks.map((check) => check.service))].map((name) => {
    const design = config.services[name];
    const serviceChecks = checks.filter((check) => check.service === name);
    const ids = new Set(serviceChecks.map((check) => check.id));
    const connections = config.connections.filter(
      (entry) =>
        inScope(entry.environments, selection.environment) &&
        (entry.service === name || entry.check_ids.some((id) => ids.has(id))),
    );
    const limitations = config.ui_only.filter(
      (entry) => entry.service === name || entry.check_ids.some((id) => ids.has(id)),
    );
    const references = [...new Set(connections.flatMap((entry) => entry.secret_refs))];
    return {
      service: name,
      ...design,
      contracts: design.contract_refs.map((id) => ({ id, paths: config.source_contracts[id] })),
      checks: serviceChecks.map((check) => ({
        ...check,
        method:
          check.rule === 'manual'
            ? 'manual_verification'
            : check.rule === 'evidence'
              ? 'metadata_or_source_only'
              : 'comparison_rule',
        method_note: ['stripe_prices', 'stripe_webhooks'].includes(check.rule)
          ? 'Production有効化待ちはmetadataのみ。Integrationは期待値比較。'
          : '検査定義の分類。実行時のblocked/manualや取得成功を示すものではありません。',
      })),
      connections,
      limitations,
      secret_references: references.map((id) => ({ id, reference: config.secret_refs[id] })),
    };
  });
  return sanitize({
    mode: 'design_coverage',
    declaration_only: true,
    network_attempted: false,
    configuration_verified: false,
    selection,
    service_count: services.length,
    check_count: checks.length,
    item_locations: itemLocations(config.resources, selection.service),
    item_location_verification_scope:
      '所在の人による確認。field・権限・期限・provider設定・replica一致は別確認。',
    services,
  }) as {
    mode: string;
    declaration_only: boolean;
    network_attempted: boolean;
    configuration_verified: boolean;
    selection: Selection;
    service_count: number;
    check_count: number;
    item_locations: ReturnType<typeof itemLocations>;
    item_location_verification_scope: string;
    services: typeof services;
  };
}

export function renderCoverage(
  config: Config,
  format: 'text' | 'json',
  selection: Selection,
): string {
  const report = designCoverage(config, selection);
  if (format === 'json') return JSON.stringify(report, null, 2);
  return [
    `Dayopt 重要設計の一覧（${report.service_count}サービス / ${report.check_count}検査定義）`,
    '台帳の宣言を表示しています。認証・通信・実設定の検証は行っていません。',
    `1Password: ${report.item_location_verification_scope}`,
    ...report.item_locations.map(
      (entry) =>
        `  所在 ${entry.service}: ${entry.vault ?? '未特定'} / ${entry.item ?? '未記録'} [${entry.presence_status}; ${entry.locator_status}]` +
        (entry.confirmed_by ? ` 確認者=${entry.confirmed_by} 日付=${entry.verified_at}` : '') +
        ('reason' in entry && entry.reason ? ` 理由=${entry.reason}` : ''),
    ),
    ...report.services.flatMap((entry) => [
      `\n${entry.service}: ${entry.purpose}`,
      `  停止時の影響: ${entry.failure_impact}`,
      `  再確認: ${entry.review_triggers.join(' / ')}`,
      `  正本: ${entry.contracts.flatMap((contract) => contract.paths).join(', ')}`,
      `  設計: ${JSON.stringify(entry.expected)}`,
      ...entry.checks.map(
        (check) => `  ${check.id} [${check.method}] ${check.environments.join(',')}`,
      ),
      ...entry.connections.map(
        (connection) =>
          `  接続 ${connection.id}: ${connection.from} → ${connection.to} / ${connection.expected}`,
      ),
      ...entry.limitations.map(
        (limitation) =>
          `  制約 ${limitation.id} [${limitation.category}]: ${limitation.reason} / 次: ${limitation.next_step}`,
      ),
    ]),
  ].join('\n');
}
