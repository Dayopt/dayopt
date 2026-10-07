import { Resolver } from 'node:dns/promises';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { failureCode } from '../safety.ts';
import type { Observation, ReaderContext } from '../types.ts';

const CONTRACTS: Record<string, { paths: string[]; live: string; reason: string; next: string }> = {
  onepassword: {
    paths: ['docs/operations/secrets.md', 'scripts/tasks/env/schema.ts'],
    live: 'access_and_recovery',
    reason:
      'Secret references do not prove item presence, Vault permissions, replica equality or human account recovery.',
    next: '人間用itemはVault・正確なitem名・confirmed_by・verified_atだけを台帳へ記録。Service Accountのagent vault read-only境界と復旧担当を人が確認し、取得不能を不存在と扱わない。値やTOTP/recovery codeは表示しない。',
  },
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

const MANUAL_CONTROLS: Record<string, { id: string; reason: string; next: string }[]> = {
  cloudflare: [
    {
      id: 'email_routing',
      reason:
        'MX/SPF do not establish Email Routing routes, verified destinations or catch-all state.',
      next: '既存Cloudflare Email Routingでsupport@の転送先認証・route有効・catch-all無効を確認。個人Gmail addressやメール本文は記録しない。正本: docs/operations/contact-email.md。',
    },
    {
      id: 'zone_operations',
      reason:
        'Public DNS does not establish the full zone, proxy mode, DNSSEC or account recovery ownership.',
      next: '既存Cloudflare zoneのDNS一覧・Vercel向けDNS only・DNSSECと権限/復旧担当を確認。登録事業者の管理画面と権威DNSを別々に扱う。',
    },
    {
      id: 'restore_readiness',
      reason:
        'Backup runs, bucket locks and retention metadata do not prove a successful restore or current recovery readiness.',
      next: '最新の復元演習の日時・対象revision・結果・担当と復旧手順の正本を確認。doctorはbackup同期・復元・cronを実行しない。',
    },
  ],
  sentry: [
    {
      id: 'alert_authority',
      reason:
        'Project and release metadata do not prove alert delivery, notification ownership or read/edit/delete token capabilities.',
      next: 'Sentry既存alert/通知先・担当とtoken scopeをmetadata/UIで確認。read-only token名から編集/削除権限を推定せず、test event送信や設定変更は行わない。正本: docs/operations/monitoring.md / secrets.md。',
    },
  ],
};

function manualControls(service: string): Observation[] {
  return (MANUAL_CONTROLS[service] ?? []).map((entry) => ({
    key: `${service}.${entry.id}`,
    environment: 'shared',
    value: null,
    source: 'manual_design_control',
    status: 'manual',
    reason: entry.reason,
    next_step: entry.next,
  }));
}

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
  const observed: Observation[] = await Promise.all(
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
  if (ctx.environment === 'all')
    observed.push({
      key: 'vercel.preview.public_health',
      environment: 'preview',
      source: 'public.health',
      value: null,
      status: 'manual',
      reason: 'Arbitrary Preview deployment URLs are not selected automatically.',
      next_step: '対象PRの既存deployment URLを指定して読み取り確認してください。',
    });
  return observed;
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

async function registration(ctx: ReaderContext): Promise<Observation[]> {
  const key = 'cloudflare.registrar_metadata';
  const source = 'public.domain_registration';
  let metadata: Observation;
  try {
    const raw = await ctx.request(source);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('metadata_missing');
    const data = raw as Record<string, unknown>;
    if (data.ldhName !== 'dayopt.app') throw new Error('domain_identity_mismatch');
    const rows = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value)
        ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        : [];
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    metadata = {
      key,
      source,
      environment: 'shared',
      value: {
        domain: 'dayopt.app',
        registrar: rows(data.entities)
          .filter((entry) => Array.isArray(entry.roles) && entry.roles.includes('registrar'))
          .map((entry) => {
            const vcard =
              Array.isArray(entry.vcardArray) && Array.isArray(entry.vcardArray[1])
                ? entry.vcardArray[1]
                : [];
            return {
              id: text(entry.handle),
              name: text(
                vcard.find((field: unknown) => Array.isArray(field) && field[0] === 'fn')?.[3],
              ),
            };
          }),
        events: rows(data.events)
          .filter((entry) =>
            ['registration', 'expiration', 'last changed'].includes(String(entry.eventAction)),
          )
          .map((entry) => ({ action: text(entry.eventAction), date: text(entry.eventDate) })),
        nameservers: rows(data.nameservers).map((entry) => text(entry.ldhName)),
        delegation_signed:
          typeof rows([data.secureDNS])[0]?.delegationSigned === 'boolean'
            ? rows([data.secureDNS])[0].delegationSigned
            : null,
      },
    };
  } catch (error) {
    metadata = {
      key,
      source,
      environment: 'shared',
      value: null,
      status: 'blocked',
      reason: failureCode(error),
      next_step: '公開登録情報の接続・domain identityを確認。未取得を未登録と解釈しない。',
    };
  }
  return [
    metadata,
    {
      key: 'cloudflare.registrar_operations',
      source: 'registrar_dashboard',
      environment: 'shared',
      value: null,
      status: 'manual',
      reason:
        'Public registration metadata does not establish auto-renewal, payment or account recovery settings.',
      next_step:
        '既存の登録事業者Dashboardで自動更新・更新担当・回復方法を確認。支払情報や個人連絡先は出力しない。',
    },
  ];
}

/** Static contract presence and public metadata are separate from unverified live settings. */
export async function readLocal(service: string, ctx: ReaderContext): Promise<Observation[]> {
  const name = service.toLowerCase();
  if (Object.hasOwn(CONTRACTS, name))
    return [
      ...(await contract(name, ctx)),
      ...(name === 'mcp_oauth' ? await oauthMetadata(ctx) : []),
    ];
  if (name === 'cloudflare')
    return [...(await dns()), ...(await registration(ctx)), ...manualControls(name)];
  if (name === 'sentry') return manualControls(name);
  if (name === 'vercel') return health(ctx);
  if (name === 'github')
    return [
      {
        key: 'github.installed_apps',
        source: 'GitHub installed Apps / repository settings',
        environment: 'shared',
        value: null,
        status: 'manual',
        reason: 'Repository hooks do not establish installed GitHub Apps or their permissions.',
        next_step:
          '認証済みrepo SettingsでApp名・権限・対象repoを確認。未取得を未接続と解釈しない。',
      },
    ];
  return [];
}
