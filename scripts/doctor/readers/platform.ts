import { AUTH_CONFIG_CONTRACT } from '../../ci/production-auth-config-audit.mjs';
import { auditProjectMetadata, auditProjectSettings } from '../../ci/production-config-audit.mjs';
import type { Observation, ReaderContext } from '../types.ts';

type Row = Record<string, unknown>;
type PlatformService = 'github' | 'vercel' | 'supabase';
const PROJECT_REF = 'yvglwblxrnrenfifsnje';

function record(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function rows(value: unknown, field?: string): Row[] {
  const source = field ? record(value)[field] : value;
  if (!Array.isArray(source)) throw new Error('Unexpected metadata response shape');
  return source.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Unexpected metadata row');
    }
    return record(row);
  });
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string')
    : [];
}

function fields(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, scalar(row[key])]));
}

/** Strip userinfo, query and fragments even from nominally public callback URLs. */
function publicUrl(value: unknown, strict = false): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['https:', 'http:', 'cursor:'].includes(parsed.protocol)) return null;
    if (strict && (parsed.username || parsed.password || parsed.search || parsed.hash)) return null;
    if (value === parsed.origin) return parsed.origin;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function observation(
  key: string,
  environment: string,
  value: unknown,
  source: string,
): Observation {
  return { key, environment, value, source };
}

/** Do not propagate API error bodies: they can contain credentials or request URLs. */
async function collect(
  output: Observation[],
  ctx: ReaderContext,
  operation: string,
  key: string,
  environment: string,
  project: (value: unknown) => unknown,
  params?: Row,
): Promise<unknown | undefined> {
  try {
    const response = await ctx.request(operation, params);
    output.push(observation(key, environment, project(response), operation));
    return response;
  } catch (error) {
    const failure = record(error);
    const knownCodes = new Set([
      'AUTH_MISSING',
      'AUTH_FAILED',
      'FORBIDDEN',
      'HTTP_ERROR',
      'NETWORK_ERROR',
      'UNSUPPORTED_OPERATION',
      'INVALID_RESPONSE',
      'PAGINATION_LIMIT',
      'POLICY_BLOCKED',
      'request_timeout',
    ]);
    const code =
      typeof failure.code === 'string' && knownCodes.has(failure.code)
        ? failure.code
        : 'READ_FAILED';
    const status =
      typeof failure.status === 'number' &&
      Number.isInteger(failure.status) &&
      failure.status >= 100 &&
      failure.status <= 599
        ? ` HTTP ${failure.status}`
        : '';
    output.push({
      key,
      environment,
      value: null,
      source: operation,
      status: 'blocked',
      reason: `${code}${status}: 読み取り権限、接続、または応答形式を確認できませんでした。APIエラー本文は表示しません。`,
      next_step: '既存の認証とAPI権限を確認し、読み取りだけを再実行してください。',
    });
    return undefined;
  }
}

async function github(ctx: ReaderContext): Promise<Observation[]> {
  const output: Observation[] = [];
  const repo = { owner: 'Dayopt', repository: 'dayopt' };
  await collect(
    output,
    ctx,
    'github.repository',
    'github.repository',
    'shared',
    (value) => {
      const row = record(value);
      if (row.full_name !== 'Dayopt/dayopt') throw new Error('Repository identity mismatch');
      return fields(row, [
        'full_name',
        'visibility',
        'private',
        'default_branch',
        'archived',
        'allow_merge_commit',
        'allow_squash_merge',
        'allow_rebase_merge',
        'delete_branch_on_merge',
      ]);
    },
    repo,
  );
  // The transport expands every ruleset summary to its GET detail before returning.
  await collect(
    output,
    ctx,
    'github.rulesets',
    'github.rulesets',
    'shared',
    (value) =>
      rows(value).map((row) => {
        const refName = record(record(row.conditions).ref_name);
        return {
          ...fields(row, ['id', 'name', 'target', 'enforcement']),
          includes: strings(refName.include),
          excludes: strings(refName.exclude),
          bypass_actors: rows(row.bypass_actors ?? []).map((actor) =>
            fields(actor, ['actor_id', 'actor_type', 'bypass_mode']),
          ),
          rules: rows(row.rules).map((rule) => {
            const parameters = record(rule.parameters);
            return {
              type: scalar(rule.type),
              required_review_count: scalar(parameters.required_approving_review_count),
              dismiss_stale_reviews: scalar(parameters.dismiss_stale_reviews_on_push),
              require_last_push_approval: scalar(parameters.require_last_push_approval),
              strict_required_checks: scalar(parameters.strict_required_status_checks_policy),
              required_checks: rows(parameters.required_status_checks ?? []).map((check) =>
                fields(check, ['context', 'integration_id']),
              ),
              require_thread_resolution: scalar(parameters.required_review_thread_resolution),
              allowed_merge_methods: strings(parameters.allowed_merge_methods),
            };
          }),
        };
      }),
    repo,
  );
  const environments = await collect(
    output,
    ctx,
    'github.environments',
    'github.environments',
    'shared',
    (value) =>
      rows(value, 'environments').map((row) => ({
        ...fields(row, ['id', 'name']),
        protection_rule_types: rows(row.protection_rules ?? []).map((rule) => scalar(rule.type)),
        deployment_branch_policy: fields(record(row.deployment_branch_policy), [
          'protected_branches',
          'custom_branch_policies',
        ]),
      })),
    repo,
  );
  if (environments !== undefined) {
    for (const environment of rows(environments, 'environments')) {
      // Only Dayopt's documented operational environments; no arbitrary discovered scope.
      if (!['production-release', 'production-ops'].includes(String(environment.name))) continue;
      const name = String(environment.name);
      await collect(
        output,
        ctx,
        'github.environment_secrets',
        `github.${name}.secret_names`,
        'production',
        (value) => rows(value, 'secrets').map((row) => scalar(row.name)),
        { ...repo, environment: name },
      );
    }
  }
  await collect(
    output,
    ctx,
    'github.workflows',
    'github.workflows',
    'shared',
    (value) => rows(value, 'workflows').map((row) => fields(row, ['id', 'name', 'path', 'state'])),
    repo,
  );
  await collect(
    output,
    ctx,
    'github.repository_hooks',
    'github.repository_hooks',
    'shared',
    (value) =>
      rows(value).map((row) => ({
        ...fields(row, ['id', 'name', 'active']),
        events: strings(row.events),
        // Deploy Hook and Slack webhook paths can themselves be bearer credentials.
        destination_origin: (() => {
          const clean = publicUrl(record(row.config).url);
          return clean ? new URL(clean).origin : null;
        })(),
      })),
    repo,
  );
  return output;
}

async function vercel(ctx: ReaderContext): Promise<Observation[]> {
  const output: Observation[] = [];
  for (const project of ['product', 'web'] as const) {
    const params = { project, environment: ctx.environment };
    await collect(
      output,
      ctx,
      'vercel.project',
      `vercel.${project}.settings`,
      'shared',
      (value) => {
        const row = record(value);
        if (row.name !== project || typeof row.id !== 'string')
          throw new Error('Project identity mismatch');
        return {
          ...fields(row, [
            'id',
            'name',
            'rootDirectory',
            'framework',
            'nodeVersion',
            'autoAssignCustomDomains',
            'enableAffectedProjectsDeployments',
            'enableNodejsSourceMaps',
            'sourceFilesOutsideRootDirectory',
          ]),
          function_default_timeout: scalar(record(row.resourceConfig).functionDefaultTimeout),
          git_link: fields(record(row.link), ['type', 'org', 'repo', 'repoId', 'productionBranch']),
          // protectionBypass object keys are secrets; never traverse or emit them.
          deployment_protection_configured: Boolean(row.ssoProtection || row.passwordProtection),
          ignore_command_override_present: row.commandForIgnoringBuildStep != null,
          contract_errors: auditProjectSettings(project, row),
        };
      },
      params,
    );
    await collect(
      output,
      ctx,
      'vercel.env',
      `vercel.${project}.environment_metadata`,
      ctx.environment,
      (value) => {
        const envs = rows(value, 'envs');
        return {
          entries: envs.map((row) => ({
            ...fields(row, ['key', 'type', 'gitBranch']),
            targets: strings(row.target),
            custom_environment_ids: strings(row.customEnvironmentIds),
            // Even NEXT_PUBLIC values are never returned from this metadata request.
          })),
          contract_errors: auditProjectMetadata(project, { envs }),
        };
      },
      params,
    );
    await collect(
      output,
      ctx,
      'vercel.binding',
      `vercel.${project}.public_bindings`,
      ctx.environment,
      (value) =>
        rows(value).map((row) => {
          const key = row.key;
          const urls = new Set([
            'NEXT_PUBLIC_SUPABASE_URL',
            'NEXT_PUBLIC_APP_URL',
            'NEXT_PUBLIC_SITE_URL',
            'OAUTH_AUTHORIZATION_SERVER_URI',
            'MCP_CANONICAL_RESOURCE_URI',
          ]);
          const text = new Set([
            'MCP_OAUTH_ENVIRONMENT',
            'MCP_OAUTH_PREVIEW_BRANCH',
            'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
            'MCP_WRITE_ENABLED_CLIENTS',
            'STRIPE_ACCOUNT_ID',
            'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID',
            'GOOGLE_CALENDAR_CLIENT_ID',
            'GOOGLE_CALENDAR_PROJECT_NUMBER',
          ]);
          const booleans = new Set([
            'STRIPE_LIVEMODE',
            'BILLING_ENFORCED',
            'NEXT_PUBLIC_MAINTENANCE_MODE',
            'NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED',
            'POSTHOG_SERVER_ENABLED',
          ]);
          const lists = new Set([
            'GOOGLE_CALENDAR_REDIRECT_URIS',
            'OAUTH_CLAUDE_REDIRECT_URIS',
            'OAUTH_CHATGPT_REDIRECT_URIS',
            'OAUTH_CURSOR_REDIRECT_URIS',
          ]);
          // These keys may expose only presence, never their values, even if transport accidentally returns them.
          const presence = new Set([
            'POSTHOG_PERSONAL_API_KEY',
            'NEXT_PUBLIC_POSTHOG_PROJECT_KEY',
            'CALENDAR_TOKEN_ENCRYPTION_KEY',
            'GOOGLE_CALENDAR_CLIENT_SECRET',
            'STRIPE_SECRET_KEY',
            'STRIPE_WEBHOOK_SECRET',
            'SUPABASE_SECRET_KEY',
            'RECOVERY_CODE_PEPPER',
            'CRON_SECRET',
            'UPSTASH_REDIS_REST_TOKEN',
            'RESEND_API_KEY',
            'RESEND_WEBHOOK_SECRET',
          ]);
          if (
            typeof key !== 'string' ||
            ![urls, text, booleans, lists, presence].some((allow) => allow.has(key))
          ) {
            throw new Error('Unexpected public binding key');
          }
          let safeValue: unknown = null;
          if (urls.has(key)) safeValue = publicUrl(row.value, true);
          if (text.has(key)) safeValue = scalar(row.value);
          if (booleans.has(key))
            safeValue =
              row.value === true || row.value === 'true'
                ? true
                : row.value === false || row.value === 'false'
                  ? false
                  : null;
          if (lists.has(key))
            safeValue =
              typeof row.value === 'string'
                ? row.value.split(',').map((url) => publicUrl(url.trim()))
                : null;
          if (presence.has(key)) safeValue = typeof row.present === 'boolean' ? row.present : null;
          return {
            key,
            target: strings(row.target),
            gitBranch: scalar(row.gitBranch),
            custom_environment_ids: strings(row.customEnvironmentIds),
            value: safeValue,
          };
        }),
      params,
    );
    await collect(
      output,
      ctx,
      'vercel.domains',
      `vercel.${project}.domains`,
      'shared',
      (value) =>
        rows(value, 'domains').map((row) =>
          fields(row, [
            'name',
            'verified',
            'gitBranch',
            'customEnvironmentId',
            'redirect',
            'redirectStatusCode',
          ]),
        ),
      params,
    );
    await collect(
      output,
      ctx,
      'vercel.deployments',
      `vercel.${project}.deployments`,
      ctx.environment,
      (value) =>
        rows(value, 'deployments').map((row) => ({
          ...fields(row, ['uid', 'id', 'name', 'target', 'readyState', 'created']),
          url: publicUrl(row.url),
          source_sha: scalar(record(row.meta).githubCommitSha),
          branch: scalar(record(row.meta).githubCommitRef),
          // targets.production is not evidence of a live alias assignment.
        })),
      params,
    );
  }
  return output;
}

async function supabase(ctx: ReaderContext): Promise<Observation[]> {
  const output: Observation[] = [];
  await collect(
    output,
    ctx,
    'supabase.branches',
    'supabase.branches',
    'shared',
    (value) =>
      rows(value).map((row) =>
        fields(row, [
          'id',
          'name',
          'project_ref',
          'parent_project_ref',
          'git_branch',
          'status',
          'persistent',
          'with_data',
          'is_default',
        ]),
      ),
    { project_ref: PROJECT_REF },
  );
  // Both refs are existing Dayopt resources in expected.yaml and the transport allowlist.
  // Branch-list permissions do not imply project metadata permissions.
  const projects = [
    { ref: PROJECT_REF, environment: 'production' },
    { ref: 'tilwaprottpyhlfoggbb', environment: 'integration' },
  ];
  if (['all', 'preview'].includes(ctx.environment)) {
    output.push({
      key: 'supabase.preview_project_selection',
      environment: 'preview',
      value: null,
      source: 'supabase.branches',
      status: 'manual',
      reason:
        '任意PR branchのDB参照は自動選択しません。対象branchとdeploymentの明示対応が必要です。',
      next_step: '確認対象PRのSupabase project refとVercel deploymentを明示してください。',
    });
    if (ctx.environment === 'preview') return output;
  }
  for (const target of projects) {
    if (ctx.environment !== 'all' && ctx.environment !== target.environment) continue;
    const params = { project_ref: target.ref };
    const prefix = `supabase.${target.environment}`;
    await collect(
      output,
      ctx,
      'supabase.project',
      `${prefix}.project`,
      target.environment,
      (value) => {
        const row = record(value);
        if (row.id !== target.ref) throw new Error('Project identity mismatch');
        return fields(row, ['id', 'name', 'region', 'status', 'created_at']);
      },
      params,
    );
    await collect(
      output,
      ctx,
      'supabase.auth_config',
      `${prefix}.auth_config`,
      target.environment,
      (value) => {
        const row = record(value);
        if (!Object.keys(row).length) throw new Error('Auth metadata missing');
        // Existing contract excludes captcha, SMTP and hook signing secrets.
        const values: Row = {};
        for (const entry of AUTH_CONFIG_CONTRACT as { key: string }[]) {
          const actual = row[entry.key];
          values[entry.key] =
            entry.key === 'hook_send_email_uri' || entry.key === 'site_url'
              ? publicUrl(actual)
              : entry.key === 'uri_allow_list'
                ? typeof actual === 'string'
                  ? actual.split(',').map((url) => publicUrl(url))
                  : []
                : scalar(actual);
        }
        return values;
      },
      params,
    );
    await collect(
      output,
      ctx,
      'supabase.functions',
      `${prefix}.functions`,
      target.environment,
      (value) =>
        rows(value).map((row) =>
          fields(row, [
            'id',
            'slug',
            'name',
            'status',
            'version',
            'verify_jwt',
            'created_at',
            'updated_at',
          ]),
        ),
      params,
    );
    if (target.environment === 'integration')
      output.push({
        key: `${prefix}.auth_audit`,
        environment: 'integration',
        source: 'production-auth-config-audit.mjs',
        value: null,
        status: 'manual',
        reason:
          'Production Auth baseline is not applied to Integration. Compare its separate callback and Auth contract.',
      });
    else {
      await collect(
        output,
        ctx,
        'supabase.auth_audit',
        `${prefix}.auth_audit`,
        target.environment,
        (value) => {
          const row = record(value);
          if (typeof row.passed !== 'boolean' || typeof row.error_count !== 'number') {
            throw new Error('Unexpected Auth audit result');
          }
          return { passed: row.passed, error_count: row.error_count };
        },
        params,
      );
    }
    await collect(
      output,
      ctx,
      'supabase.backups',
      `${prefix}.backup_metadata`,
      target.environment,
      (value) => {
        const row = record(value);
        if (!Object.hasOwn(row, 'backups')) throw new Error('Backup metadata missing');
        return {
          ...fields(row, ['region', 'physical_backup_data', 'pitr_enabled']),
          backups: rows(row.backups).map((backup) =>
            fields(backup, ['status', 'inserted_at', 'is_physical_backup']),
          ),
        };
      },
      params,
    );
    // This operation has one root-owned, fixed SELECT with read_only:true. No SQL is supplied by the reader.
    await collect(
      output,
      ctx,
      'supabase.database_metadata',
      `${prefix}.database_metadata`,
      target.environment,
      (value) =>
        rows(value).map((row) => ({
          migration_count: scalar(row.migration_count),
          latest_migration: scalar(row.latest_migration),
          migration_versions: strings(row.migration_versions),
          storage_rls_enabled: scalar(row.storage_rls_enabled),
          storage_rls_forced: scalar(row.storage_rls_forced),
          mcp_control: {
            ...fields(record(row.mcp_control), ['writes_enabled', 'billing_enforced', 'revision']),
            enabled_client_ids: strings(record(row.mcp_control).enabled_client_ids),
          },
          crons: rows(row.crons ?? []).map((cron) =>
            fields(cron, ['jobname', 'schedule', 'active']),
          ),
          buckets: rows(row.buckets ?? []).map((bucket) => ({
            ...fields(bucket, ['id', 'public', 'file_size_limit']),
            allowed_mime_types: strings(bucket.allowed_mime_types),
          })),
          heartbeats: rows(row.heartbeats ?? []).map((heartbeat) =>
            fields(heartbeat, ['job_name', 'last_started_at', 'last_completed_at']),
          ),
          // No auth.users, storage.objects rows, Vault values, pg_cron commands or provider payloads.
        })),
      params,
    );
  }
  return output;
}

export async function readPlatform(
  service: PlatformService,
  ctx: ReaderContext,
): Promise<Observation[]> {
  if (service === 'github') return github(ctx);
  if (service === 'vercel') return vercel(ctx);
  return supabase(ctx);
}
