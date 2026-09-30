import { setTimeout as delay } from 'node:timers/promises';
import { runAuthConfigSafeGet, SAFE_AUTH_CONFIG_FIELDS } from '../agent/supabase-mgmt-safe-get.mjs';
import {
  auditSupabaseAuthConfig,
  AUTH_CONFIG_CONTRACT,
} from '../ci/production-auth-config-audit.mjs';
import { auditProductionStorageRls, buildQuery } from '../ci/production-storage-rls-audit.mjs';
import { ReadFailure } from './safety.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const array = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new ReadFailure('INVALID_RESPONSE');
  return value.map(row);
};
const PROJECTS = {
  product: 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa',
  web: 'prj_saTfo2jhvayTDb3YoMSKmla6QryZ',
};
const SUPABASE_REFS = new Set(['yvglwblxrnrenfifsnje', 'tilwaprottpyhlfoggbb']);
export const OPERATIONS = new Set([
  'public.health',
  'public.oauth_metadata',
  'github.repository',
  'github.rulesets',
  'github.environments',
  'github.environment_secrets',
  'github.workflows',
  'github.repository_hooks',
  'github.backup_runs',
  'vercel.project',
  'vercel.env',
  'vercel.binding',
  'vercel.domains',
  'vercel.deployments',
  'supabase.project',
  'supabase.branches',
  'supabase.functions',
  'supabase.backups',
  'supabase.auth_config',
  'supabase.auth_audit',
  'supabase.database_metadata',
  'supabase.storage_audit',
  'stripe.account',
  'stripe.listPrices',
  'stripe.listWebhooks',
  'stripe.listPortalConfigurations',
  'resend.listDomains',
  'resend.getDomain',
  'resend.listWebhooks',
  'cloudflare.listZones',
  'cloudflare.listTurnstile',
  'cloudflare.listR2Buckets',
  'cloudflare.getR2Locks',
  'sentry.listProjects',
  'sentry.listReleases',
  'sentry.listReleaseFiles',
  'posthog.getProject',
  'posthog.aggregate',
  'upstash.ping',
  'uptimerobot.getMonitors',
]);
export const PUBLIC_BINDING_KEYS = new Set([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SITE_URL',
  'OAUTH_AUTHORIZATION_SERVER_URI',
  'MCP_CANONICAL_RESOURCE_URI',
  'MCP_OAUTH_ENVIRONMENT',
  'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
  'MCP_OAUTH_PREVIEW_BRANCH',
  'BILLING_ENFORCED',
  'STRIPE_ACCOUNT_ID',
  'STRIPE_LIVEMODE',
  'NEXT_PUBLIC_MAINTENANCE_MODE',
  'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID',
  'POSTHOG_SERVER_ENABLED',
  'NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED',
  'GOOGLE_CALENDAR_REDIRECT_URIS',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_PROJECT_NUMBER',
  'OAUTH_CLAUDE_REDIRECT_URIS',
  'OAUTH_CHATGPT_REDIRECT_URIS',
  'OAUTH_CURSOR_REDIRECT_URIS',
  'MCP_WRITE_ENABLED_CLIENTS',
]);
export const PRESENCE_KEYS = new Set([
  'POSTHOG_PERSONAL_API_KEY',
  'NEXT_PUBLIC_POSTHOG_PROJECT_KEY',
  'CALENDAR_TOKEN_ENCRYPTION_KEY',
  'RECOVERY_CODE_PEPPER',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SECRET_KEY',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'CRON_SECRET',
  'UPSTASH_REDIS_REST_TOKEN',
]);
export const METADATA_SQL = `SELECT
 (SELECT count(*) FROM supabase_migrations.schema_migrations) AS migration_count,
 (SELECT max(version) FROM supabase_migrations.schema_migrations) AS latest_migration,
 (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations) AS migration_versions,
 (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) AS storage_rls_enabled,
 (SELECT relforcerowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) AS storage_rls_forced,
 (SELECT row_to_json(m) FROM (SELECT writes_enabled,enabled_client_ids,billing_enforced,revision FROM public.mcp_mutation_control) m LIMIT 1) AS mcp_control,
 (SELECT json_agg(c) FROM (SELECT jobname,schedule,active FROM cron.job ORDER BY jobname) c) AS crons,
 (SELECT json_agg(b) FROM (SELECT id,public,file_size_limit,allowed_mime_types FROM storage.buckets ORDER BY id) b) AS buckets,
 (SELECT json_agg(h) FROM (SELECT job_name,last_started_at,last_completed_at FROM public.cron_heartbeats ORDER BY job_name) h) AS heartbeats`;

export function createTransport(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, unknown>();
  const cfAccounts = new Set<string>();
  const stripeIdentities = new Set<string>();
  function credential(name: string) {
    const value = env[name];
    if (!value || value.startsWith('op://')) throw new ReadFailure('AUTH_MISSING');
    return value;
  }
  async function http(
    url: URL,
    token?: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    form = false,
  ) {
    for (let retry = 0; retry <= 2; retry++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: 'application/json',
            ...(method === 'POST'
              ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
              : {}),
          },
          ...(method === 'POST' ? { body: form ? String(body) : JSON.stringify(body) } : {}),
        });
      } catch (error) {
        throw new ReadFailure(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'request_timeout'
            : 'NETWORK_ERROR',
        );
      }
      if (!response.ok) {
        if (
          (response.status === 429 || (response.status >= 500 && response.status <= 599)) &&
          retry < 2
        ) {
          await response.body?.cancel();
          await delay(250 * 2 ** retry);
          continue;
        }
        await response.body?.cancel();
        throw new ReadFailure(
          response.status === 403
            ? 'FORBIDDEN'
            : response.status === 401
              ? 'AUTH_FAILED'
              : 'HTTP_ERROR',
          response.status,
        );
      }
      try {
        return { data: (await response.json()) as unknown, link: response.headers.get('link') };
      } catch {
        throw new ReadFailure('INVALID_RESPONSE');
      }
    }
    throw new ReadFailure('read_failed');
  }
  function url(origin: string, path: string, params: Record<string, unknown> = {}) {
    const result = new URL(path, origin);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
    return result;
  }
  async function pages(initial: URL, token: string, field?: string, vercel = false) {
    let current = initial;
    const output: Row[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
      if (seen.has(current.href)) throw new ReadFailure('PAGINATION_LIMIT');
      seen.add(current.href);
      const response = await http(current, token);
      const batch = array(field ? row(response.data)[field] : response.data);
      output.push(...batch);
      const next = vercel ? row(row(response.data).pagination).next : null;
      const linked = response.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!linked && !next) return field ? { [field]: output } : output;
      if (linked) {
        const candidate = new URL(linked);
        if (candidate.origin !== initial.origin || candidate.pathname !== initial.pathname)
          throw new ReadFailure('POLICY_BLOCKED');
        current = candidate;
      } else {
        current = new URL(initial);
        current.searchParams.set('until', String(next));
      }
    }
    throw new ReadFailure('PAGINATION_LIMIT');
  }
  async function request(operation: string, params: Row = {}): Promise<unknown> {
    if (!OPERATIONS.has(operation)) throw new ReadFailure('UNSUPPORTED_OPERATION');
    if (operation === 'public.health') {
      const origins: Record<string, string> = {
        production: 'https://app.dayopt.app',
        integration: 'https://product-git-integration-dayopt.vercel.app',
      };
      if (!origins[String(params.target)]) throw new ReadFailure('POLICY_BLOCKED');
      return (await http(url(origins[String(params.target)], '/api/health/version'))).data;
    }
    if (operation === 'public.oauth_metadata') {
      const endpoints: Record<string, string> = {
        issuer: 'https://app.dayopt.app/.well-known/oauth-authorization-server',
        resource: 'https://mcp.dayopt.app/.well-known/oauth-protected-resource',
      };
      if (!endpoints[String(params.kind)]) throw new ReadFailure('POLICY_BLOCKED');
      return (await http(new URL(endpoints[String(params.kind)]))).data;
    }
    if (operation.startsWith('github.')) {
      const token = credential('GH_TOKEN');
      const base = 'https://api.github.com';
      const repo = '/repos/Dayopt/dayopt';
      switch (operation) {
        case 'github.repository':
          return (await http(url(base, repo), token)).data;
        case 'github.rulesets': {
          const list = array(await pages(url(base, `${repo}/rulesets`, { per_page: 100 }), token));
          const details = [];
          for (const item of list) {
            if (typeof item.id !== 'number') throw new ReadFailure('INVALID_RESPONSE');
            details.push((await http(url(base, `${repo}/rulesets/${item.id}`), token)).data);
          }
          return details;
        }
        case 'github.environments':
          return pages(url(base, `${repo}/environments`, { per_page: 100 }), token, 'environments');
        case 'github.environment_secrets': {
          if (!['production-release', 'production-ops'].includes(String(params.environment)))
            throw new ReadFailure('POLICY_BLOCKED');
          return pages(
            url(base, `${repo}/environments/${params.environment}/secrets`, { per_page: 100 }),
            token,
            'secrets',
          );
        }
        case 'github.workflows':
          return pages(
            url(base, `${repo}/actions/workflows`, { per_page: 100 }),
            token,
            'workflows',
          );
        case 'github.backup_runs': {
          const result = row(
            (
              await http(
                url(base, `${repo}/actions/workflows/nightly.yml/runs`, {
                  event: 'schedule',
                  branch: 'main',
                  per_page: 10,
                }),
                token,
              )
            ).data,
          );
          const runs = array(result.workflow_runs);
          const output = [];
          for (const item of runs) {
            if (typeof item.id !== 'number') throw new ReadFailure('INVALID_RESPONSE');
            const jobs = row(
              await pages(
                url(base, `${repo}/actions/runs/${item.id}/jobs`, { per_page: 100 }),
                token,
                'jobs',
              ),
            );
            output.push({
              id: item.id,
              head_sha: item.head_sha,
              created_at: item.created_at,
              conclusion: item.conclusion,
              backup_jobs: array(jobs.jobs)
                .filter((job) => job.name === 'Export Supabase Storage to R2')
                .map((job) => ({
                  name: job.name,
                  status: job.status,
                  conclusion: job.conclusion,
                  completed_at: job.completed_at,
                })),
            });
          }
          return { history_scope: 'latest_10_scheduled_main_runs_only', runs: output };
        }
        case 'github.repository_hooks':
          return pages(url(base, `${repo}/hooks`, { per_page: 100 }), token);
        default:
          throw new ReadFailure('UNSUPPORTED_OPERATION');
      }
    }
    if (operation.startsWith('vercel.')) {
      if (!['product', 'web'].includes(String(params.project)))
        throw new ReadFailure('POLICY_BLOCKED');
      const project = PROJECTS[params.project as keyof typeof PROJECTS];
      const token = credential('VERCEL_TOKEN');
      const query = { teamId: credential('VERCEL_TEAM_ID') };
      const base = 'https://api.vercel.com';
      switch (operation) {
        case 'vercel.project':
          return (await http(url(base, `/v9/projects/${project}`, query), token)).data;
        case 'vercel.env': {
          const result = await pages(
            url(base, `/v10/projects/${project}/env`, query),
            token,
            'envs',
            true,
          );
          cache.set(`env:${project}`, result);
          return result;
        }
        case 'vercel.binding': {
          const metadata = cache.get(`env:${project}`) ?? (await request('vercel.env', params));
          const bindings = [];
          for (const entry of array(row(metadata).envs)) {
            const key = String(entry.key);
            const targets = Array.isArray(entry.target) ? entry.target : [];
            if (
              params.environment !== 'all' &&
              (params.environment === 'production'
                ? !targets.includes('production')
                : !targets.includes('preview'))
            )
              continue;
            if (!PUBLIC_BINDING_KEYS.has(key) && !PRESENCE_KEYS.has(key)) continue;
            let value: unknown = { present: true };
            if (PUBLIC_BINDING_KEYS.has(key)) {
              if (entry.type === 'sensitive') value = { unavailable: 'sensitive' };
              else {
                if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id))
                  throw new ReadFailure('INVALID_RESPONSE');
                const decoded = row(
                  (await http(url(base, `/v1/projects/${project}/env/${entry.id}`, query), token))
                    .data,
                );
                value =
                  typeof decoded.value === 'string'
                    ? decoded.value
                    : { unavailable: 'missing_value' };
              }
            }
            bindings.push({
              key,
              target: targets,
              gitBranch: entry.gitBranch ?? null,
              ...(PRESENCE_KEYS.has(key) ? { present: true } : { value }),
            });
          }
          return bindings;
        }
        case 'vercel.domains':
          return pages(
            url(base, `/v9/projects/${project}/domains`, { ...query, limit: 100 }),
            token,
            'domains',
            true,
          );
        case 'vercel.deployments':
          return pages(
            url(base, '/v6/deployments', {
              ...query,
              projectId: project,
              limit: 100,
              ...(params.environment === 'production' ? { target: 'production' } : {}),
            }),
            token,
            'deployments',
            true,
          );
        default:
          throw new ReadFailure('UNSUPPORTED_OPERATION');
      }
    }
    if (operation.startsWith('supabase.')) {
      const ref = String(params.project_ref);
      if (!SUPABASE_REFS.has(ref)) throw new ReadFailure('POLICY_BLOCKED');
      const token = credential('SUPABASE_ACCESS_TOKEN');
      const base = 'https://api.supabase.com';
      const safeFetch: typeof fetch = async (input, init) => {
        const candidate = new URL(String(input));
        if (
          candidate.href !== `${base}/v1/projects/${ref}/config/auth` ||
          (init?.method && init.method !== 'GET')
        )
          throw new ReadFailure('POLICY_BLOCKED');
        const response = await http(candidate, token);
        return new Response(JSON.stringify(response.data), {
          headers: { 'Content-Type': 'application/json' },
        });
      };
      switch (operation) {
        case 'supabase.project':
          return (await http(url(base, `/v1/projects/${ref}`), token)).data;
        case 'supabase.branches':
          return (await http(url(base, `/v1/projects/${ref}/branches`), token)).data;
        case 'supabase.functions':
          return (await http(url(base, `/v1/projects/${ref}/functions`), token)).data;
        case 'supabase.backups':
          return (await http(url(base, `/v1/projects/${ref}/database/backups`), token)).data;
        case 'supabase.auth_config':
          return runAuthConfigSafeGet({
            fields: [...SAFE_AUTH_CONFIG_FIELDS],
            token,
            projectRef: ref,
            fetchImpl: safeFetch,
          });
        case 'supabase.auth_audit': {
          if (ref !== 'yvglwblxrnrenfifsnje') throw new ReadFailure('baseline_not_applicable');
          const raw = (await http(url(base, `/v1/projects/${ref}/config/auth`), token)).data;
          const errors = auditSupabaseAuthConfig(raw);
          return {
            passed: errors.length === 0,
            error_count: errors.length,
            contract_fields: AUTH_CONFIG_CONTRACT.length,
          };
        }
        case 'supabase.database_metadata':
          return (
            await http(url(base, `/v1/projects/${ref}/database/query`), token, 'POST', {
              query: METADATA_SQL,
              read_only: true,
            })
          ).data;
        case 'supabase.storage_audit': {
          const data = (
            await http(url(base, `/v1/projects/${ref}/database/query`), token, 'POST', {
              query: buildQuery(),
              read_only: true,
            })
          ).data;
          const errors = auditProductionStorageRls(data);
          return { passed: errors.length === 0, error_count: errors.length };
        }
        default:
          throw new ReadFailure('UNSUPPORTED_OPERATION');
      }
    }
    if (operation.startsWith('stripe.')) {
      const mode = params.mode;
      if (!['test', 'live'].includes(String(mode))) throw new ReadFailure('POLICY_BLOCKED');
      const token = credential(
        mode === 'live' ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_TEST_SECRET_KEY',
      );
      const base = 'https://api.stripe.com';
      if (!stripeIdentities.has(String(mode))) {
        const account = row((await http(url(base, '/v1/account'), token)).data);
        const expected = mode === 'live' ? 'acct_1TBpLgIe9fUk4fJW' : 'acct_1TBpLoRRjoh5xfrs';
        cache.set(`stripe:${mode}`, account);
        if (account.id !== expected) {
          if (operation === 'stripe.account') return account;
          throw new ReadFailure('POLICY_BLOCKED');
        }
        stripeIdentities.add(String(mode));
      }
      if (operation === 'stripe.account') return cache.get(`stripe:${mode}`);
      const paths: Record<string, string> = {
        'stripe.listPrices': '/v1/prices',
        'stripe.listWebhooks': '/v1/webhook_endpoints',
        'stripe.listPortalConfigurations': '/v1/billing_portal/configurations',
      };
      if (!paths[operation]) throw new ReadFailure('UNSUPPORTED_OPERATION');
      return (
        await http(
          url(base, paths[operation], {
            limit: 100,
            ...(operation === 'stripe.listPrices' ? { active: true } : {}),
            ...(params.starting_after ? { starting_after: params.starting_after } : {}),
          }),
          token,
        )
      ).data;
    }
    if (operation.startsWith('resend.')) {
      const token = credential('RESEND_API_KEY');
      const base = 'https://api.resend.com';
      if (operation === 'resend.getDomain') {
        if (params.id !== '1071e6d3-8624-470c-95b8-0a86b81dc44e')
          throw new ReadFailure('POLICY_BLOCKED');
        return (await http(url(base, `/domains/${params.id}`), token)).data;
      }
      const path =
        operation === 'resend.listDomains'
          ? '/domains'
          : operation === 'resend.listWebhooks'
            ? '/webhooks'
            : null;
      if (!path) throw new ReadFailure('UNSUPPORTED_OPERATION');
      return (
        await http(
          url(base, path, { limit: 100, ...(params.after ? { after: params.after } : {}) }),
          token,
        )
      ).data;
    }
    if (operation.startsWith('cloudflare.')) {
      const token = credential('CF_TOKEN');
      const base = 'https://api.cloudflare.com';
      if (operation === 'cloudflare.listZones') {
        const data = (
          await http(
            url(base, '/client/v4/zones', {
              name: 'dayopt.app',
              page: params.page ?? 1,
              per_page: 50,
            }),
            token,
          )
        ).data;
        for (const zone of array(row(data).result))
          if (zone.name === 'dayopt.app' && typeof row(zone.account).id === 'string')
            cfAccounts.add(String(row(zone.account).id));
        return data;
      }
      if (!cfAccounts.has(String(params.account_id))) throw new ReadFailure('POLICY_BLOCKED');
      const account = String(params.account_id);
      let path: string;
      switch (operation) {
        case 'cloudflare.listTurnstile':
          path = `/client/v4/accounts/${account}/challenges/widgets`;
          break;
        case 'cloudflare.listR2Buckets':
          path = `/client/v4/accounts/${account}/r2/buckets`;
          break;
        case 'cloudflare.getR2Locks':
          if (!['avatars', 'attachments'].includes(String(params.bucket)))
            throw new ReadFailure('POLICY_BLOCKED');
          path = `/client/v4/accounts/${account}/r2/buckets/${params.bucket}/locks`;
          break;
        default:
          throw new ReadFailure('UNSUPPORTED_OPERATION');
      }
      return (await http(url(base, path, { page: params.page ?? 1, per_page: 50 }), token)).data;
    }
    if (operation.startsWith('sentry.')) {
      const token = credential('SENTRY_AUTH_TOKEN');
      const base = 'https://sentry.io';
      let path = '/api/0/organizations/dayopt/projects/';
      if (operation !== 'sentry.listProjects') {
        if (!['dayopt', 'dayopt-web'].includes(String(params.project)))
          throw new ReadFailure('POLICY_BLOCKED');
        path = `/api/0/projects/dayopt/${params.project}/releases/`;
        if (operation === 'sentry.listReleaseFiles') {
          if (typeof params.release !== 'string') throw new ReadFailure('INVALID_RESPONSE');
          path += `${encodeURIComponent(params.release)}/files/`;
        } else if (operation !== 'sentry.listReleases')
          throw new ReadFailure('UNSUPPORTED_OPERATION');
      }
      return pages(url(base, path), token);
    }
    if (operation === 'posthog.getProject')
      return (
        await http(
          url('https://us.posthog.com', '/api/projects/625917/'),
          credential('POSTHOG_READONLY'),
        )
      ).data;
    if (operation === 'posthog.aggregate') {
      const query =
        "SELECT properties.environment AS environment, count() AS count FROM events WHERE timestamp >= now() - INTERVAL 7 DAY AND properties.environment IN ('production', 'preview', 'integration') GROUP BY environment";
      const data = row(
        (
          await http(
            url('https://us.posthog.com', '/api/projects/625917/query/'),
            credential('POSTHOG_READONLY'),
            'POST',
            { query: { kind: 'HogQLQuery', query } },
          )
        ).data,
      );
      if (!Array.isArray(data.results)) throw new ReadFailure('INVALID_RESPONSE');
      return data.results.map((entry: unknown) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number')
          throw new ReadFailure('INVALID_RESPONSE');
        return { environment: entry[0], count: entry[1] };
      });
    }
    if (operation === 'upstash.ping') {
      const endpoint = new URL(credential('UPSTASH_REDIS_REST_URL'));
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.hostname !== 'discrete-sloth-103465.upstash.io'
      )
        throw new ReadFailure('POLICY_BLOCKED');
      return (await http(url(endpoint.origin, '/ping'), credential('UPSTASH_REDIS_REST_TOKEN')))
        .data;
    }
    if (operation === 'uptimerobot.getMonitors') {
      const body = new URLSearchParams({
        api_key: credential('UPTIME_KEY'),
        format: 'json',
        limit: '50',
        offset: String(params.offset ?? 0),
      });
      return (
        await http(
          url('https://api.uptimerobot.com', '/v2/getMonitors'),
          undefined,
          'POST',
          body,
          true,
        )
      ).data;
    }
    throw new ReadFailure('UNSUPPORTED_OPERATION');
  }
  return request;
}
