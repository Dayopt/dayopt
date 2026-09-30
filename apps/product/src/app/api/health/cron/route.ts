import { NextResponse } from 'next/server';

import { logger } from '@/lib/logger';
import {
  assertDatabaseOAuthIdentity,
  resolveDatabaseOAuthProjectRef,
} from '@/lib/oauth-server/database-identity';
import { evaluateHeartbeats, JOB_MAX_AGE_MINUTES } from '@/lib/ops/cron-heartbeat-policy.mjs';
import { cronHeartbeatHealthRateLimit } from '@/lib/rate-limit/upstash';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

export const maxDuration = 20;

const DATABASE_CHECK_TIMEOUT_MS = 5_000;
const LAST_RESULT_MAX_AGE_MS = 60_000;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

type HeartbeatStatus = 'healthy' | 'unhealthy';

let lastResult: { status: HeartbeatStatus; httpStatus: number; at: number } | null = null;

function isProductionDeployment(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production';
  return process.env.NODE_ENV === 'production';
}

function responseFor(status: HeartbeatStatus, httpStatus: number, headers?: HeadersInit) {
  return NextResponse.json(
    { status },
    {
      status: httpStatus,
      headers: { ...NO_STORE_HEADERS, ...headers },
    },
  );
}

function remember(status: HeartbeatStatus): NextResponse {
  const httpStatus = status === 'healthy' ? 200 : 503;
  lastResult = { status, httpStatus, at: Date.now() };
  return responseFor(status, httpStatus);
}

function replayableResult(): NextResponse | null {
  if (!lastResult) return null;
  const ageMs = Date.now() - lastResult.at;
  if (ageMs < 0 || ageMs > LAST_RESULT_MAX_AGE_MS) return null;
  return responseFor(lastResult.status, lastResult.httpStatus, {
    'X-Health-Check-Replayed': 'true',
    'X-Health-Check-Age-Ms': String(ageMs),
  });
}

async function exceedsRateLimit(): Promise<boolean> {
  if (!cronHeartbeatHealthRateLimit) return false;
  try {
    const { success } = await cronHeartbeatHealthRateLimit.limit('cron-heartbeat-health');
    return !success;
  } catch {
    // Monitoring remains available when the limiter backend is unavailable.
    return false;
  }
}

async function readHeartbeatRows() {
  const client = createServiceRoleClient();
  const signal = AbortSignal.timeout(DATABASE_CHECK_TIMEOUT_MS);

  const { getOAuthEnvironmentConfig } = await import('@/lib/oauth-server/identity-env');
  const expectedIdentity = getOAuthEnvironmentConfig();
  const expectedSupabaseProjectRef = resolveDatabaseOAuthProjectRef({
    environment: expectedIdentity.environment,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  await assertDatabaseOAuthIdentity(
    expectedIdentity,
    () => client.rpc('get_mcp_environment_identity_v1').abortSignal(signal),
    expectedSupabaseProjectRef,
  );

  const { data, error } = await client
    .from('cron_heartbeats')
    .select('job_name,last_completed_at')
    .in('job_name', Object.keys(JOB_MAX_AGE_MINUTES))
    .abortSignal(signal);

  if (error || !Array.isArray(data)) throw new Error('Cron heartbeat query failed');
  return data;
}

export async function GET() {
  if (!isProductionDeployment()) return responseFor('unhealthy', 503);

  if (await exceedsRateLimit()) {
    const replayed = replayableResult();
    if (replayed) return replayed;
    // Protect the database if this process has no recent result to replay.
    return responseFor('unhealthy', 503);
  }

  try {
    const failures = evaluateHeartbeats(await readHeartbeatRows());
    return remember(failures.length === 0 ? 'healthy' : 'unhealthy');
  } catch {
    logger.error('[cron-health] heartbeat check failed', {
      feature: 'operations',
      operation: 'cron_heartbeat_health_check',
    });
    return remember('unhealthy');
  }
}
