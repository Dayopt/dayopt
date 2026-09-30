import { Resolver } from 'node:dns/promises';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { failureCode } from '../safety.ts';
import type { Observation, ReaderContext } from '../types.ts';

const CONTRACTS: Record<string, { paths: string[]; live: string; reason: string; next: string }> = {
  google: {
    paths: ['docs/operations/google-oauth-verification.md', 'docs/operations/secrets.md'],
    live: 'registered_callbacks',
    reason:
      'Repository contracts do not establish Google Console registered callbacks, consent status or deployed client selection.',
    next: 'Compare the existing Auth and Calendar clients separately in Google Console with their deployed callback allowlists; do not reveal client secrets.',
  },
  mcp_oauth: {
    paths: ['apps/product/production-build-gate.mjs', 'docs/operations/secrets.md'],
    live: 'deployed_identity_and_client_callbacks',
    reason:
      'Source contracts do not prove deployed issuer/resource identity, client callbacks or Preview isolation.',
    next: 'Compare public discovery and selected deployment bindings against the existing Production or explicit MCP Preview contract.',
  },
  telemetry: {
    paths: [
      'apps/product/src/lib/analytics/posthog-deletion.ts',
      'docs/operations/product-analytics.md',
      'docs/operations/posthog-analytics.md',
    ],
    live: 'deployed_privacy_and_vercel_analytics',
    reason:
      'Source files do not establish live consent, replay masking or Vercel Analytics/Speed Insights project settings.',
    next: 'Inspect existing project settings and the current deployed revision; distinguish source configuration from runtime ingestion.',
  },
  pwned_passwords: {
    paths: ['apps/product/src/lib/auth/pwned-password.ts'],
    live: 'provider_and_deployed_behavior',
    reason:
      'The source contract does not prove live HIBP availability or the deployed password flow.',
    next: 'Inspect the deployed revision and existing provider evidence; this doctor does not submit passwords or execute account flows.',
  },
  support_smtp: {
    paths: ['docs/operations/secrets.md'],
    live: 'gmail_sender_and_smtp_replica',
    reason:
      'The dedicated support SMTP contract does not prove Gmail sender or credential synchronization.',
    next: 'Confirm Gmail Send mail as configuration and the dedicated existing human/resend-support-replies item without exposing its value or sending mail.',
  },
  optional: {
    paths: ['docs/operations/jev.md', 'scripts/tasks/env/schema.ts'],
    live: 'jev_gateway_budget_and_credentials',
    reason:
      'Optional Jev/Gateway source contracts do not prove the current project budget or key scope.',
    next: 'Inspect existing Vercel AI Gateway project/key metadata and budget settings; do not invoke models or create keys.',
  },
};

async function contract(service: string, ctx: ReaderContext): Promise<Observation[]> {
  const spec = CONTRACTS[service];
  const entries = await Promise.all(
    spec.paths.map(async (path) => {
      try {
        await access(resolve(ctx.root, path));
        return { path, present: true };
      } catch {
        return { path, present: false };
      }
    }),
  );
  return [
    {
      key: `${service}.source_contract`,
      environment: 'shared',
      value: { files: entries },
      source: 'repository_contract_paths',
      ...(entries.some((entry) => !entry.present)
        ? {
            status: 'blocked' as const,
            reason: 'source_contract_missing',
            next_step:
              'Restore or update the canonical contract path before treating the contract as available.',
          }
        : {}),
    },
    {
      key: `${service}.${spec.live}`,
      environment: ctx.environment,
      value: null,
      source: 'repository_contract',
      status: 'manual',
      reason: spec.reason,
      next_step: spec.next,
    },
  ];
}

async function dns(): Promise<Observation[]> {
  const resolver = new Resolver({ timeout: 10_000, tries: 1 });
  const requests = [
    { key: 'ns', host: 'dayopt.app', read: () => resolver.resolveNs('dayopt.app') },
    {
      key: 'app_cname',
      host: 'app.dayopt.app',
      read: () => resolver.resolveCname('app.dayopt.app'),
    },
    {
      key: 'mcp_cname',
      host: 'mcp.dayopt.app',
      read: () => resolver.resolveCname('mcp.dayopt.app'),
    },
    { key: 'apex_mx', host: 'dayopt.app', read: () => resolver.resolveMx('dayopt.app') },
    { key: 'send_mx', host: 'send.dayopt.app', read: () => resolver.resolveMx('send.dayopt.app') },
    { key: 'apex_spf', host: 'dayopt.app', read: () => resolver.resolveTxt('dayopt.app') },
    {
      key: 'send_spf',
      host: 'send.dayopt.app',
      read: () => resolver.resolveTxt('send.dayopt.app'),
    },
    {
      key: 'dkim',
      host: 'resend._domainkey.dayopt.app',
      read: () => resolver.resolveTxt('resend._domainkey.dayopt.app'),
    },
    {
      key: 'dmarc',
      host: '_dmarc.dayopt.app',
      read: () => resolver.resolveTxt('_dmarc.dayopt.app'),
    },
  ];
  return Promise.all(
    requests.map(async (request) => {
      const source = `public_dns:${request.host}`;
      const key = `cloudflare.public_dns.${request.key}`;
      try {
        const response = await request.read();
        let value: unknown = response;
        if (['apex_spf', 'send_spf', 'dkim', 'dmarc'].includes(request.key)) {
          const text = (response as string[][]).map((parts) => parts.join(''));
          if (request.key.endsWith('spf'))
            value = text.filter((row) => /^v=spf1(?:\s|$)/i.test(row));
          if (request.key === 'dkim')
            value = text
              .filter((row) => /(?:^|;)\s*p=/i.test(row))
              .map((row) => ({
                record_present: true,
                public_key_present: /(?:^|;)\s*p=\s*[^;\s]+/i.test(row),
                key_type: /(?:^|;)\s*k=\s*([a-z0-9-]+)/i.exec(row)?.[1] ?? null,
              }));
          if (request.key === 'dmarc')
            value = text
              .filter((row) => /^v=DMARC1(?:;|$)/i.test(row))
              .map((row) => ({
                policy:
                  /(?:^|;)\s*p=\s*(none|quarantine|reject)(?:\s*;|\s*$)/i
                    .exec(row)?.[1]
                    ?.toLowerCase() ?? null,
              }));
        }
        return { key, environment: 'shared', value, source };
      } catch {
        return {
          key,
          environment: 'shared',
          value: null,
          source,
          status: 'blocked' as const,
          reason: 'dns_lookup_failed_or_record_absent',
          next_step:
            'Check the record and resolver in the existing Cloudflare zone; public DNS does not establish proxy mode or the full zone inventory.',
        };
      }
    }),
  );
}

async function health(ctx: ReaderContext): Promise<Observation[]> {
  const targets =
    ctx.environment === 'production'
      ? ['production']
      : ctx.environment === 'integration'
        ? ['integration']
        : ctx.environment === 'all'
          ? ['production', 'integration']
          : [];
  if (!targets.length)
    return [
      {
        key: 'vercel.preview.public_health',
        environment: 'preview',
        value: null,
        source: 'public.health',
        status: 'manual',
        reason: 'Arbitrary Preview deployment URLs are not selected automatically.',
        next_step:
          'Provide an explicit existing PR deployment identity for a separate read-only check.',
      },
    ];
  return Promise.all(
    targets.map(async (target) => {
      const key = `vercel.${target}.public_health`;
      try {
        const response = await ctx.request('public.health', { target });
        if (!response || typeof response !== 'object' || Array.isArray(response))
          throw new Error('invalid_response');
        const row = response as Record<string, unknown>;
        const preview =
          row.preview && typeof row.preview === 'object' && !Array.isArray(row.preview)
            ? (row.preview as Record<string, unknown>)
            : {};
        const sha = preview.sha ?? row.commitSha;
        const value = {
          sha: typeof sha === 'string' && /^[a-f0-9]{7,40}$/i.test(sha) ? sha : null,
          version:
            typeof row.version === 'string' &&
            /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(row.version)
              ? row.version
              : null,
          supabase_project_ref:
            typeof preview.supabaseProjectRef === 'string' &&
            /^[a-z]{20}$/.test(preview.supabaseProjectRef)
              ? preview.supabaseProjectRef
              : null,
        };
        if (value.sha === null || value.version === null)
          throw new Error('health_identity_missing');
        return { key, environment: target, value, source: 'public.health' };
      } catch (error) {
        return {
          key,
          environment: target,
          value: null,
          source: 'public.health',
          status: 'blocked' as const,
          reason: failureCode(error),
          next_step:
            'Inspect the existing deployment and protection settings; this public request does not inject bypass credentials or establish DB connectivity.',
        };
      }
    }),
  );
}

async function oauthMetadata(ctx: ReaderContext): Promise<Observation[]> {
  if (!['all', 'production'].includes(ctx.environment)) return [];
  return Promise.all(
    ['issuer', 'resource'].map(async (kind) => {
      const key = `mcp_oauth.production.${kind}`;
      try {
        const raw = await ctx.request('public.oauth_metadata', { kind });
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('metadata_missing');
        const data = raw as Record<string, unknown>;
        const safeOrigin = (value: unknown) => {
          if (typeof value !== 'string') return null;
          const parsed = new URL(value);
          if (
            parsed.protocol !== 'https:' ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            parsed.pathname !== '/'
          )
            return null;
          return parsed.origin;
        };
        const value =
          kind === 'issuer'
            ? {
                issuer: safeOrigin(data.issuer),
                code_challenge_methods_supported: Array.isArray(
                  data.code_challenge_methods_supported,
                )
                  ? data.code_challenge_methods_supported.filter((item) => item === 'S256')
                  : [],
              }
            : {
                resource: safeOrigin(data.resource),
                authorization_servers: Array.isArray(data.authorization_servers)
                  ? data.authorization_servers.map(safeOrigin)
                  : [],
              };
        return { key, environment: 'production', value, source: 'public.oauth_metadata' };
      } catch (error) {
        return {
          key,
          environment: 'production',
          value: null,
          source: 'public.oauth_metadata',
          status: 'blocked' as const,
          reason: failureCode(error),
          next_step:
            '公開discovery metadataと配信環境を確認してください。OAuthフローや登録操作は実行しません。',
        };
      }
    }),
  );
}

/** Static contract presence and public metadata are separate from unverified live settings. */
export async function readLocal(service: string, ctx: ReaderContext): Promise<Observation[]> {
  const name = service.toLowerCase();
  if (Object.hasOwn(CONTRACTS, name))
    return [
      ...(await contract(name, ctx)),
      ...(name === 'mcp_oauth' ? await oauthMetadata(ctx) : []),
    ];
  if (name === 'cloudflare') return dns();
  if (name === 'vercel') return health(ctx);
  return [];
}
