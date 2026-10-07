import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { failureCode, ReadFailure } from './safety.ts';
import type { Environment, Observation } from './types.ts';

export const CREDENTIALS: Record<string, Record<string, string>> = {
  github: { GH_TOKEN: 'op://agent/github-agent/credential' },
  vercel: {
    VERCEL_TOKEN: 'op://ci/vercel-production/VERCEL_TOKEN',
    VERCEL_TEAM_ID: 'op://ci/vercel-production/VERCEL_TEAM_ID',
  },
  supabase: { SUPABASE_ACCESS_TOKEN: 'op://agent/supabase-agent/credential' },
  stripe: {
    STRIPE_TEST_SECRET_KEY: 'op://agent/stripe-test/STRIPE_SECRET_KEY',
    STRIPE_LIVE_SECRET_KEY: 'op://human/stripe-live/STRIPE_SECRET_KEY',
  },
  resend: { RESEND_API_KEY: 'op://human/resend-send/RESEND_API_KEY' },
  cloudflare: { CF_TOKEN: 'op://ci/Cloudflare-R2-storagebackup/Token value' },
  sentry: { SENTRY_AUTH_TOKEN: 'op://agent/sentry-cli-readonly/credential' },
  posthog: { POSTHOG_READONLY: 'op://agent/potshog-readonly/credential' },
  upstash: {
    UPSTASH_REDIS_REST_URL: 'op://agent/upstash/UPSTASH_REDIS_REST_URL',
    UPSTASH_REDIS_REST_TOKEN: 'op://agent/upstash/UPSTASH_REDIS_REST_TOKEN',
  },
  uptimerobot: { UPTIME_KEY: 'op://agent/UptimeRobot Read-only API Key /credential' },
};
export function collectorEnvironment(
  service: string,
  inherited: NodeJS.ProcessEnv,
  environment: Environment = 'all',
): NodeJS.ProcessEnv {
  // Do not let op resolve unrelated op:// variables from the caller's environment.
  const safe = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'DOCTOR_TRUSTED_REVISION',
      'SSH_AUTH_SOCK',
      'OP_BIOMETRIC_UNLOCK_ENABLED',
      // The existing op wrapper uses these identifiers to select agent-only auth.
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
    ].flatMap((name) => (inherited[name] ? [[name, inherited[name]]] : [])),
  );
  const credentials = { ...CREDENTIALS[service] };
  if (service === 'stripe' && environment !== 'all') {
    delete credentials[
      environment === 'production' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'
    ];
  }
  return { ...safe, ...credentials, DOCTOR_INTERNAL: '1' };
}
export async function collectAuthenticated(
  service: string,
  environment: Environment,
  root: string,
): Promise<Observation[]> {
  if (service !== 'stripe' || environment !== 'all')
    return collectOne(service, environment, root, 120_000);
  const deadline = Date.now() + 120_000;
  const output: Observation[] = [];
  const definitions = loadConfig(root).checks.filter((check) => check.service === service);
  for (const scope of ['production', 'integration'] as const) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ReadFailure('authorization_or_service_timeout');
      output.push(...(await collectOne(service, scope, root, remaining)));
    } catch (error) {
      output.push(
        ...definitions.map((check) => ({
          key: check.id,
          environment: scope,
          source: 'op run',
          value: null,
          status: 'blocked' as const,
          reason: failureCode(error),
          next_step: check.next_step,
        })),
      );
    }
  }
  return output;
}
async function collectOne(
  service: string,
  environment: Environment,
  root: string,
  timeoutMs: number,
): Promise<Observation[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'op',
      [
        'run',
        '--',
        process.execPath,
        resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        resolve(root, 'scripts/doctor/cli.ts'),
        '--collector',
        service,
        '--environment',
        environment,
      ],
      {
        cwd: root,
        env: collectorEnvironment(service, process.env, environment),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    let output = '';
    let diagnostic = '';
    let finished = false;
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      const hardStop = setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 2000);
      hardStop.unref();
    };
    const timeout = setTimeout(() => {
      if (!finished) {
        stop();
        finished = true;
        reject(new ReadFailure('authorization_or_service_timeout'));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4_000_000) {
        stop();
        finished = true;
        clearTimeout(timeout);
        reject(new ReadFailure('collector_output_limit'));
      }
    });
    // Capture only enough to classify; never print op stderr or embed it in a result.
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostic.length < 8192) diagnostic += chunk.toString();
    });
    child.on('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(new ReadFailure('op_unavailable'));
      }
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (code !== 0)
        return reject(
          new ReadFailure(
            /authorization timeout/i.test(diagnostic)
              ? 'authorization_timeout'
              : 'credential_or_collector_failed',
          ),
        );
      try {
        const data: unknown = JSON.parse(output);
        if (!Array.isArray(data)) throw new Error();
        resolvePromise(data as Observation[]);
      } catch {
        reject(new ReadFailure('collector_invalid_json'));
      }
    });
  });
}
