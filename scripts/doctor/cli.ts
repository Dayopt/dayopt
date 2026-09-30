import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectAuthenticated, CREDENTIALS } from './auth.ts';
import { compare, RULES } from './compare.ts';
import { loadConfig } from './config.ts';
import { databaseChecks } from './database.ts';
import { evaluatePreviewPolicy } from './preview-policy.ts';
import { readLocal } from './readers/local.ts';
import { readPlatform } from './readers/platform.ts';
import { readService } from './readers/services.ts';
import { previewReferences } from './relations.ts';
import { exitCode, renderReport } from './report.ts';
import { failureCode, sanitize } from './safety.ts';
import { createTransport } from './transport.ts';
import type { Definition, Environment, Observation, Result } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function parseArgs(args: string[]) {
  let service: string | undefined;
  let environment: Environment = 'all';
  let format: 'text' | 'json' = 'text';
  let offline = false;
  let list = false;
  let help = false;
  let collector: string | undefined;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--service':
        service = args[++i];
        if (!service) throw new Error('service');
        break;
      case '--environment':
        environment = args[++i] as Environment;
        if (!['all', 'production', 'preview', 'integration'].includes(environment))
          throw new Error('environment');
        break;
      case '--format':
        format = args[++i] as 'text' | 'json';
        if (!['text', 'json'].includes(format)) throw new Error('format');
        break;
      case '--offline':
        offline = true;
        break;
      case '--list':
        list = true;
        break;
      case '--help':
        help = true;
        break;
      case '--collector':
        collector = args[++i];
        if (process.env.DOCTOR_INTERNAL !== '1' || !CREDENTIALS[collector])
          throw new Error('internal');
        break;
      default:
        throw new Error('argument');
    }
  }
  return { service, environment, format, offline, list, help, collector };
}
function selected(definition: Definition, environment: Environment) {
  return (
    environment === 'all' ||
    definition.environments.some((scope) => ['all', 'shared', environment].includes(scope))
  );
}
function revision(root: string) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}
async function read(
  service: string,
  environment: Environment,
  root: string,
): Promise<Observation[]> {
  const ctx = { root, environment, request: createTransport(process.env) };
  const observed = ['github', 'vercel', 'supabase'].includes(service)
    ? await readPlatform(service as 'github' | 'vercel' | 'supabase', ctx)
    : await readService(service, ctx);
  if (service === 'github') {
    try {
      observed.push({
        key: 'github.backup_runs',
        environment: 'production',
        source: 'github.backup_runs',
        value: await ctx.request('github.backup_runs'),
      });
    } catch (error) {
      observed.push({
        key: 'github.backup_runs',
        environment: 'production',
        source: 'github.backup_runs',
        value: null,
        status: 'blocked',
        reason: failureCode(error),
      });
    }
  }
  if (service === 'supabase' && environment !== 'preview') {
    for (const scope of environment === 'all' ? ['production', 'integration'] : [environment]) {
      if (scope !== 'production') continue;
      try {
        observed.push({
          key: 'supabase.production.storage_audit',
          environment: scope,
          value: await ctx.request('supabase.storage_audit', {
            project_ref: 'yvglwblxrnrenfifsnje',
          }),
          source: 'supabase.storage_audit',
        });
      } catch (error) {
        observed.push({
          key: 'supabase.production.storage_audit',
          environment: scope,
          value: null,
          source: 'supabase.storage_audit',
          status: 'blocked',
          reason: failureCode(error),
        });
      }
    }
  }
  if (service === 'supabase') {
    observed.push(...(await databaseChecks(ctx, observed)));
    if (['all', 'production'].includes(environment))
      observed.push({
        key: 'supabase.production.cron_schedule_review',
        environment: 'production',
        source: 'fixed database metadata / deployed migration',
        value: null,
        status: 'manual',
        reason: 'cron_schedule_requires_deployed_contract_review',
      });
  }
  return observed;
}
export async function run(args: string[], root = ROOT): Promise<number> {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(
      'pnpm run doctor [--service NAME] [--environment all|production|preview|integration] [--format text|json] [--offline] [--list]\n読み取り専用。pnpm doctor はpnpm組み込みの別コマンドです。\n',
    );
    return 0;
  }
  if (options.collector) {
    const observations = await read(options.collector, options.environment, root);
    const secretValues = Object.keys(CREDENTIALS[options.collector])
      .map((key) => process.env[key] ?? '')
      .filter(Boolean);
    process.stdout.write(JSON.stringify(sanitize(observations, secretValues)) + '\n');
    return 0;
  }
  const config = loadConfig(root);
  const services = new Set(config.checks.map((check) => check.service));
  if (options.service && !services.has(options.service)) throw new Error('Unknown service');
  for (const check of config.checks)
    if (!RULES.includes(check.rule as (typeof RULES)[number])) throw new Error('Unknown rule');
  const definitions = config.checks.filter(
    (check) =>
      (!options.service || check.service === options.service) &&
      selected(check, options.environment),
  );
  if (!definitions.length) throw new Error('Empty selection');
  if (options.list) {
    process.stdout.write(
      options.format === 'json'
        ? JSON.stringify(definitions, null, 2) + '\n'
        : definitions
            .map((check) => `${check.id} [${check.service}/${check.environments.join(',')}]`)
            .join('\n') + '\n',
    );
    return 0;
  }
  if (options.offline) {
    process.stdout.write(
      options.format === 'json'
        ? JSON.stringify({
            mode: 'offline',
            schema_valid: true,
            check_count: definitions.length,
            network_attempted: false,
          }) + '\n'
        : `期待値・正本参照・検査定義: 有効（${definitions.length}項目）。認証・通信は行っていません。\n`,
    );
    return 0;
  }
  const results: Result[] = [];
  const observations: Observation[] = [];
  for (const service of new Set(definitions.map((check) => check.service))) {
    const local = await readLocal(service, {
      root,
      environment: options.environment,
      request: createTransport({}),
    });
    observations.push(...local);
    let error: string | undefined;
    if (CREDENTIALS[service]) {
      if (options.format === 'text') process.stderr.write(`点検中: ${service}\n`);
      try {
        observations.push(...(await collectAuthenticated(service, options.environment, root)));
      } catch (failure) {
        error = failureCode(failure);
      }
    }
    for (const definition of definitions.filter((check) => check.service === service)) {
      if (
        ['vercel.preview.database_references', 'vercel.preview.mcp_build_policy'].includes(
          definition.id,
        )
      )
        continue;
      const matches = observations.filter(
        (observation) =>
          observation.key === definition.id &&
          (options.environment === 'all' ||
            ['shared', 'all', options.environment].includes(observation.environment)),
      );
      if (matches.length)
        for (const observation of matches) results.push(compare(definition, observation));
      else
        results.push(
          compare(definition, {
            key: definition.id,
            environment: options.environment,
            value: null,
            source: CREDENTIALS[service] ? 'op run / reader' : 'source contract',
            status: 'blocked',
            reason: error ?? 'evidence_not_returned',
          }),
        );
    }
  }
  for (const definition of definitions.filter(
    (check) => check.id === 'vercel.preview.database_references',
  )) {
    results.push(compare(definition, previewReferences(observations)));
  }
  for (const definition of definitions.filter(
    (check) => check.id === 'vercel.preview.mcp_build_policy',
  ))
    results.push(compare(definition, evaluatePreviewPolicy(observations)));
  const unmatched = observations.filter(
    (observation) => !config.checks.some((check) => check.id === observation.key),
  );
  if (unmatched.length) throw new Error('Unregistered observation');
  process.stdout.write(
    renderReport(results, options.format, {
      mode: 'live_read_only',
      repo_revision: revision(root),
      expectation_revision: config.scope.repository_baseline,
      advisories: config.advisories,
      checked_at_jst: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }) + ' JST',
    }) + '\n',
  );
  return exitCode(results);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        'doctor: 引数、期待値、検査定義、または内部処理を確認してください。秘密を含み得る例外本文は表示しません。\n',
      );
      process.exitCode = 3;
    });
}
