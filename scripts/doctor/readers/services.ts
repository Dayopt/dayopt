import { ReadFailure } from '../safety.ts';
import type { Observation, ReaderContext } from '../types.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(record);
  const body = record(value);
  for (const key of ['data', 'result', 'results', 'items', 'monitors']) {
    if (Array.isArray(body[key])) return (body[key] as unknown[]).map(record);
  }
  throw new Error('unexpected_list_shape');
};
const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const safeHost = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.hostname : null;
  } catch {
    return null;
  }
};
const safeOrigins = (value: unknown): string[] => [
  ...new Set(
    strings(value).flatMap((entry) => {
      try {
        const url = new URL(entry);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
          ? [url.origin]
          : [];
      } catch {
        return [];
      }
    }),
  ),
];
const arrayLength = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);
const safeUrl = (value: unknown): { origin: string; path: string } | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const permitted =
      /^\/(?:api\/(?:health(?:\/version)?|webhooks\/(?:stripe|resend)|integrations\/google-calendar\/callback)|auth\/v1\/callback)?\/?$/.test(
        url.pathname,
      );
    return { origin: url.origin, path: permitted ? url.pathname : '[path-redacted]' };
  } catch {
    return null;
  }
};
function assertProviderSuccess(value: unknown): void {
  if (value === null || value === undefined) throw new Error('missing_response');
  const body = record(value);
  if (body.success === false || body.stat === 'fail' || body.error)
    throw new Error('provider_read_failed');
}
const dayoptUrl = (value: unknown): boolean => {
  const url = safeUrl(value);
  if (!url) return false;
  const host = new URL(url.origin).hostname;
  return (
    host === 'dayopt.app' ||
    host.endsWith('.dayopt.app') ||
    /^product-git-[a-z0-9-]+-dayopt\.vercel\.app$/u.test(host)
  );
};

/** Each API operation is isolated; failures never expose provider response bodies. */
async function observe(
  ctx: ReaderContext,
  output: Observation[],
  key: string,
  environment: string,
  operation: string,
  params: Record<string, unknown>,
  project: (value: unknown) => unknown,
): Promise<unknown | undefined> {
  try {
    const response = await ctx.request(operation, params);
    assertProviderSuccess(response);
    output.push({ key, environment, value: project(response), source: operation });
    return response;
  } catch (error) {
    const detail = record(error);
    const status =
      typeof detail.status === 'number'
        ? detail.status
        : typeof detail.statusCode === 'number'
          ? detail.statusCode
          : null;
    output.push({
      key,
      environment,
      value: null,
      source: operation,
      status: 'blocked',
      reason:
        detail.code === 'dayopt_zone_not_visible'
          ? 'dayopt_zone_not_visible'
          : status === 403 || detail.code === 'FORBIDDEN'
            ? 'insufficient_access'
            : status === 401
              ? 'authentication_failed'
              : status === 404
                ? 'resource_not_accessible'
                : 'read_failed',
      next_step:
        'Confirm the existing credential scope and resource in the provider UI; do not issue new credentials.',
    });
    return undefined;
  }
}

async function list(
  ctx: ReaderContext,
  operation: string,
  params: Row,
  kind: 'stripe' | 'resend' | 'cloudflare' | 'uptimerobot' | 'plain',
): Promise<Row[]> {
  const all: Row[] = [];
  let pageParams = { ...params };
  const seen = new Set<string>();
  for (let page = 0; page < 50; page += 1) {
    const response = await ctx.request(operation, pageParams);
    assertProviderSuccess(response);
    const body = record(response);
    const batch = rows(response);
    all.push(...batch);
    if (kind === 'stripe' || kind === 'resend') {
      if (body.has_more !== true) return all;
      const cursor = batch.at(-1)?.id;
      if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('pagination_incomplete');
      seen.add(cursor);
      pageParams = { ...pageParams, [kind === 'stripe' ? 'starting_after' : 'after']: cursor };
    } else if (kind === 'cloudflare') {
      const info = record(body.result_info);
      const current = typeof info.page === 'number' ? info.page : 1;
      const total = typeof info.total_pages === 'number' ? info.total_pages : 1;
      if (current >= total) return all;
      pageParams = { ...pageParams, page: current + 1 };
    } else if (kind === 'uptimerobot') {
      const pagination = record(body.pagination);
      const total = typeof pagination.total === 'number' ? pagination.total : batch.length;
      if (all.length >= total) return all;
      if (!batch.length) throw new Error('pagination_incomplete');
      pageParams = { ...pageParams, offset: all.length };
    } else {
      // The transport owns Link-header pagination for providers that return arrays.
      return all;
    }
  }
  throw new Error('pagination_limit');
}

function listingContext(ctx: ReaderContext, kind: Parameters<typeof list>[3]): ReaderContext {
  return { ...ctx, request: (operation, params = {}) => list(ctx, operation, params, kind) };
}

function manual(
  output: Observation[],
  key: string,
  environment: string,
  source: string,
  reason: string,
): void {
  output.push({
    key,
    environment,
    value: null,
    source,
    status: 'manual',
    reason,
    next_step:
      'Confirm the declared contract through provider metadata or the current deployed revision.',
  });
}

async function stripe(ctx: ReaderContext, output: Observation[]): Promise<void> {
  const modes =
    ctx.environment === 'production'
      ? ['live']
      : ctx.environment === 'all'
        ? ['live', 'test']
        : ['test'];
  for (const mode of modes) {
    const environment = mode === 'live' ? 'production' : 'integration';
    await observe(
      ctx,
      output,
      'stripe.account',
      environment,
      'stripe.account',
      { mode },
      (value) => {
        const body = record(value);
        return {
          id: scalar(body.id),
          charges_enabled: scalar(body.charges_enabled),
          payouts_enabled: scalar(body.payouts_enabled),
          details_submitted: scalar(body.details_submitted),
          default_currency: scalar(body.default_currency),
        };
      },
    );
    await observe(
      listingContext(ctx, 'stripe'),
      output,
      'stripe.active_prices',
      environment,
      'stripe.listPrices',
      { mode, active: true, limit: 100 },
      (value) =>
        rows(value).map((price) => ({
          id: scalar(price.id),
          active: scalar(price.active),
          livemode: scalar(price.livemode),
          currency: scalar(price.currency),
          unit_amount: scalar(price.unit_amount),
          interval: scalar(record(price.recurring).interval),
          interval_count: scalar(record(price.recurring).interval_count),
          tax_behavior: scalar(price.tax_behavior),
          product:
            typeof price.product === 'string' ? price.product : scalar(record(price.product).id),
        })),
    );
    await observe(
      listingContext(ctx, 'stripe'),
      output,
      'stripe.webhooks',
      environment,
      'stripe.listWebhooks',
      { mode, limit: 100 },
      (value) =>
        rows(value).map((row) => ({
          id: scalar(row.id),
          endpoint: safeUrl(row.url),
          status: scalar(row.status),
          livemode: scalar(row.livemode),
          api_version: scalar(row.api_version),
          events: Array.isArray(row.enabled_events) ? strings(row.enabled_events) : null,
        })),
    );
    await observe(
      listingContext(ctx, 'stripe'),
      output,
      'stripe.portal',
      environment,
      'stripe.listPortalConfigurations',
      { mode, limit: 100 },
      (value) =>
        rows(value).map((row) => {
          const features = record(row.features);
          return {
            id: scalar(row.id),
            active: scalar(row.active),
            is_default: scalar(row.is_default),
            livemode: scalar(row.livemode),
            default_return_url: safeUrl(row.default_return_url),
            features: Object.fromEntries(
              [
                'customer_update',
                'invoice_history',
                'payment_method_update',
                'subscription_cancel',
                'subscription_update',
              ].map((key) => [key, scalar(record(features[key]).enabled)]),
            ),
          };
        }),
    );
    manual(
      output,
      'stripe.deployed_identity_and_billing_gate',
      environment,
      'repository_contract',
      'Deployed account/mode pins, billing flags and trial behavior require cross-reader comparison.',
    );
  }
}

async function resend(ctx: ReaderContext, output: Observation[]): Promise<void> {
  const domains = await observe(
    listingContext(ctx, 'resend'),
    output,
    'resend.domains',
    'production',
    'resend.listDomains',
    { limit: 100 },
    (value) =>
      rows(value)
        .filter((row) => row.name === 'dayopt.app')
        .map((row) => ({
          id: scalar(row.id),
          name: scalar(row.name),
          status: scalar(row.status),
          region: scalar(row.region),
        })),
  );
  for (const domain of rows(domains).filter((row) => row.name === 'dayopt.app')) {
    if (typeof domain.id !== 'string') continue;
    await observe(
      ctx,
      output,
      'resend.domain_settings',
      'production',
      'resend.getDomain',
      { id: domain.id },
      (value) => {
        const row = record(value);
        const capabilities = record(row.capabilities);
        return {
          id: scalar(row.id),
          name: scalar(row.name),
          status: scalar(row.status),
          region: scalar(row.region),
          sending: scalar(capabilities.sending),
          receiving: scalar(capabilities.receiving),
          open_tracking: scalar(row.open_tracking),
          click_tracking: scalar(row.click_tracking),
        };
      },
    );
  }
  await observe(
    listingContext(ctx, 'resend'),
    output,
    'resend.webhooks',
    'production',
    'resend.listWebhooks',
    { limit: 100 },
    (value) =>
      rows(value).map((row) => ({
        id: scalar(row.id),
        endpoint: safeUrl(row.endpoint),
        status: scalar(row.status),
        events: Array.isArray(row.events) ? strings(row.events) : null,
      })),
  );
  manual(
    output,
    'resend.sender_and_signature_replicas',
    'production',
    'repository_contract',
    'Sensitive replicas and Auth Edge/Gmail SMTP configuration cannot be inferred from domain verification.',
  );
}

async function cloudflare(ctx: ReaderContext, output: Observation[]): Promise<void> {
  const zones = await observe(
    listingContext(ctx, 'cloudflare'),
    output,
    'cloudflare.zone',
    'all',
    'cloudflare.listZones',
    { name: 'dayopt.app', page: 1, per_page: 50 },
    (value) => {
      const matching = rows(value).filter((row) => row.name === 'dayopt.app');
      // Scoped credentials may return an empty list for an existing zone.
      // Missing visibility proves neither resource absence nor a matching configuration.
      if (!matching.length) throw new ReadFailure('dayopt_zone_not_visible');
      return matching.map((row) => ({
        id: scalar(row.id),
        name: scalar(row.name),
        status: scalar(row.status),
        name_servers: strings(row.name_servers),
        account_id: scalar(record(row.account).id),
      }));
    },
  );
  const accounts = new Set(
    rows(zones)
      .filter((row) => row.name === 'dayopt.app')
      .map((row) => record(row.account).id),
  );
  for (const accountId of accounts) {
    if (typeof accountId !== 'string') continue;
    await observe(
      listingContext(ctx, 'cloudflare'),
      output,
      'cloudflare.turnstile',
      'all',
      'cloudflare.listTurnstile',
      { account_id: accountId, page: 1, per_page: 50 },
      (value) =>
        rows(value)
          .filter((row) =>
            strings(row.domains).some(
              (domain) => domain === 'dayopt.app' || domain.endsWith('.dayopt.app'),
            ),
          )
          .map((row) => ({
            name: scalar(row.name),
            mode: scalar(row.mode),
            domains: strings(row.domains),
            bot_fight_mode: scalar(row.bot_fight_mode),
          })),
    );
    const buckets = await observe(
      ctx,
      output,
      'cloudflare.r2_buckets',
      'production',
      'cloudflare.listR2Buckets',
      { account_id: accountId },
      (value) => {
        const result = record(record(value).result);
        const bucketsValue = Array.isArray(result.buckets) ? result.buckets : record(value).buckets;
        if (!Array.isArray(bucketsValue)) throw new Error('missing_bucket_array');
        return rows(bucketsValue)
          .filter((row) => ['avatars', 'attachments'].includes(String(row.name)))
          .map((row) => ({
            name: scalar(row.name),
            location: scalar(row.location),
            storage_class: scalar(row.storage_class),
          }));
      },
    );
    if (buckets !== undefined) {
      for (const bucket of ['avatars', 'attachments']) {
        await observe(
          ctx,
          output,
          `cloudflare.r2_locks.${bucket}`,
          'production',
          'cloudflare.getR2Locks',
          { account_id: accountId, bucket },
          (value) => {
            const body = record(value);
            const result = record(body.result);
            const rules = result.rules ?? body.rules ?? body.result;
            if (!Array.isArray(rules)) throw new Error('missing_lock_array');
            return rows(rules).map((row) => ({
              id: scalar(row.id),
              enabled: scalar(row.enabled),
              condition_type: scalar(record(row.condition).type),
              max_age_seconds: scalar(record(row.condition).maxAgeSeconds),
            }));
          },
        );
      }
    }
  }
  manual(
    output,
    'cloudflare.backup_credential_scope',
    'production',
    'repository_contract',
    'Bucket availability does not prove source or destination token scope, retention, or restore capability.',
  );
}

async function sentry(ctx: ReaderContext, output: Observation[]): Promise<void> {
  await observe(
    ctx,
    output,
    'sentry.projects',
    'production',
    'sentry.listProjects',
    { organization: 'dayopt' },
    (value) =>
      rows(value)
        .filter((row) => ['dayopt', 'dayopt-web'].includes(String(row.slug)))
        .map((row) => ({
          id: scalar(row.id),
          slug: scalar(row.slug),
          platform: scalar(row.platform),
          status: scalar(row.status),
        })),
  );
  await observe(
    ctx,
    output,
    'sentry.organization_settings',
    'production',
    'sentry.getOrganization',
    { organization: 'dayopt' },
    (value) => {
      const row = record(value);
      return {
        require_two_factor: scalar(row.require2FA),
        allow_member_invite: scalar(row.allowMemberInvite),
        allow_member_project_creation: scalar(row.allowMemberProjectCreation),
        allow_superuser_access: scalar(row.allowSuperuserAccess),
        open_membership: scalar(row.openMembership),
        allow_join_requests: scalar(row.allowJoinRequests),
        events_member_admin: scalar(row.eventsMemberAdmin),
        alerts_member_write: scalar(row.alertsMemberWrite),
        enhanced_privacy: scalar(row.enhancedPrivacy),
        data_scrubber: scalar(row.dataScrubber),
        data_scrubber_defaults: scalar(row.dataScrubberDefaults),
        scrub_ip_addresses: scalar(row.scrubIPAddresses),
        sensitive_field_count: arrayLength(row.sensitiveFields),
        safe_field_count: arrayLength(row.safeFields),
      };
    },
  );
  for (const project of ['dayopt', 'dayopt-web']) {
    await observe(
      ctx,
      output,
      `sentry.project_settings.${project}`,
      'production',
      'sentry.getProject',
      { organization: 'dayopt', project },
      (value) => {
        const row = record(value);
        return {
          id: scalar(row.id),
          slug: scalar(row.slug),
          is_public: scalar(row.isPublic),
          allowed_domains: safeOrigins(row.allowedDomains),
          data_scrubber: scalar(row.dataScrubber),
          data_scrubber_defaults: scalar(row.dataScrubberDefaults),
          scrub_ip_addresses: scalar(row.scrubIPAddresses),
          verify_ssl: scalar(row.verifySSL),
          scrape_javascript: scalar(row.scrapeJavaScript),
          is_dynamically_sampled: scalar(row.isDynamicallySampled),
          target_sample_rate: scalar(row.targetSampleRate),
          sensitive_field_count: arrayLength(row.sensitiveFields),
        };
      },
    );
    await observe(
      ctx,
      output,
      `sentry.environments.${project}`,
      'production',
      'sentry.listProjectEnvironments',
      { organization: 'dayopt', project, visibility: 'all' },
      (value) =>
        rows(value)
          .map((row) => ({ name: scalar(row.name), visibility: scalar(row.visibility) }))
          .filter((row) => typeof row.name === 'string'),
    );
    await observe(
      ctx,
      output,
      `sentry.service_hooks.${project}`,
      'production',
      'sentry.listProjectHooks',
      { organization: 'dayopt', project },
      (value) => {
        const hooks = rows(value);
        return {
          count: hooks.length,
          events: [...new Set(hooks.flatMap((hook) => strings(hook.events)))].sort(),
          destination_hosts: [
            ...new Set(
              hooks
                .map((hook) => safeHost(hook.url))
                .filter((host): host is string => host !== null),
            ),
          ].sort(),
        };
      },
    );
    const releases = await observe(
      ctx,
      output,
      `sentry.releases.${project}`,
      'production',
      'sentry.listReleases',
      { organization: 'dayopt', project, limit: 20 },
      (value) =>
        rows(value).map((row) => ({
          version: scalar(row.version),
          date_created: scalar(row.dateCreated),
          date_released: scalar(row.dateReleased),
        })),
    );
    const version = rows(releases)[0]?.version;
    if (typeof version === 'string') {
      await observe(
        ctx,
        output,
        `sentry.release_files.${project}`,
        'production',
        'sentry.listReleaseFiles',
        { organization: 'dayopt', project, release: version },
        (value) => ({
          file_count: rows(value).length,
          evidence_scope:
            'legacy release files only; artifact bundles and stack trace application are not established',
        }),
      );
    }
  }
  manual(
    output,
    'sentry.applied_source_maps',
    'production',
    'repository_contract',
    'Release metadata and legacy file count do not prove artifact bundle or source map application to the served release.',
  );
}

async function posthog(ctx: ReaderContext, output: Observation[]): Promise<void> {
  await observe(
    ctx,
    output,
    'posthog.settings',
    'all',
    'posthog.getProject',
    { project_id: 625917 },
    (value) => {
      const row = record(value);
      return {
        id: scalar(row.id),
        name: scalar(row.name),
        timezone: scalar(row.timezone),
        session_recording_opt_in: scalar(row.session_recording_opt_in),
        autocapture_opt_out: scalar(row.autocapture_opt_out),
        recording_domains: strings(row.recording_domains),
      };
    },
  );
  await observe(
    ctx,
    output,
    'posthog.ingestion_aggregate',
    'all',
    'posthog.aggregate',
    { project_id: 625917, aggregate: 'dayopt_environment_count_7d' },
    (value) =>
      rows(value).map((row) => ({
        environment: ['production', 'preview', 'integration', 'unknown'].includes(
          String(row.environment),
        )
          ? row.environment
          : 'other',
        count: typeof row.count === 'number' ? row.count : null,
      })),
  );
  manual(
    output,
    'posthog.deployed_privacy_and_deletion',
    'all',
    'repository_contract',
    'Confirm consent, deletion credential replication and deployed browser/server switches separately.',
  );
}

/** Read-only operations only; the transport enforces resource and credential boundaries. */
export async function readService(service: string, ctx: ReaderContext): Promise<Observation[]> {
  const output: Observation[] = [];
  switch (service.toLowerCase()) {
    case 'stripe':
      await stripe(ctx, output);
      break;
    case 'resend':
      await resend(ctx, output);
      break;
    case 'cloudflare':
      await cloudflare(ctx, output);
      break;
    case 'sentry':
      await sentry(ctx, output);
      break;
    case 'posthog':
      await posthog(ctx, output);
      break;
    case 'upstash':
      await observe(
        ctx,
        output,
        'upstash.ping',
        'shared',
        'upstash.ping',
        { environment: ctx.environment },
        (value) => {
          if (record(value).result !== 'PONG' && value !== 'PONG')
            throw new Error('invalid_ping_shape');
          return {
            reachable: true,
            credential_target: 'agent_master',
            evidence_scope: 'PING does not prove database isolation or token permission scope',
          };
        },
      );
      manual(
        output,
        'upstash.environment_isolation',
        ctx.environment,
        'repository_contract',
        'Only the shared agent master credential was probed. Production, Preview and Integration database bindings and isolation remain unverified.',
      );
      break;
    case 'uptimerobot':
      await observe(
        listingContext(ctx, 'uptimerobot'),
        output,
        'uptimerobot.monitors',
        'production',
        'uptimerobot.getMonitors',
        { offset: 0, limit: 50 },
        (value) =>
          rows(value)
            .filter((row) => dayoptUrl(row.url))
            .map((row) => ({
              id: scalar(row.id),
              endpoint: safeUrl(row.url),
              type: scalar(row.type),
              status: scalar(row.status),
              interval_seconds: scalar(row.interval),
            })),
      );
      break;
    default:
      output.push({
        key: service,
        environment: ctx.environment,
        value: null,
        source: 'reader',
        status: 'not_applicable',
        reason: 'unsupported_service',
      });
  }
  return output;
}
