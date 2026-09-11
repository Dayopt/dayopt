import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { logger } from '@/lib/logger';
import {
  assertDatabaseOAuthIdentity,
  resolveDatabaseOAuthProjectRef,
} from '@/lib/oauth-server/database-identity';

import { resolveHealthStatus, type OverallHealthStatus } from './health-status';

/**
 * DB check 5s ×2（identity RPC → profiles select の逐次）+ Redis ping（5s）+ env チェック。
 * 外形監視の信号を「timeout」に化けさせないため短めに抑える。
 */
export const maxDuration = 30;

/**
 * Health Check API エンドポイント
 *
 * アプリケーションの稼働状況を確認するためのヘルスチェック
 * デプロイ後の動作確認やモニタリングに使用
 */

interface HealthStatus {
  status: OverallHealthStatus;
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    database: 'ok' | 'error' | 'warning';
    redis: 'ok' | 'error' | 'warning' | 'skipped';
  };
  details?: {
    error?: string;
    warnings?: string[];
  };
}

/** DB疎通タイムアウト（ms） */
const DB_CHECK_TIMEOUT_MS = 5_000;

/** Redis疎通タイムアウト（ms） */
const REDIS_CHECK_TIMEOUT_MS = 5_000;

/**
 * production で必須の環境変数が揃っていることを確認する。
 * Preview では production 専用 secret を要求しない。
 */
async function hasValidOperationalEnvironment(): Promise<boolean> {
  if (!isOperationalDeployment()) {
    return true;
  }

  try {
    const { env } = await import('@/env');
    void env.NEXT_PUBLIC_SUPABASE_URL;
    return true;
  } catch {
    return false;
  }
}

/**
 * データベース接続チェック — profiles への副作用のない SELECT で疎通確認
 */
async function checkDatabase(): Promise<'ok' | 'error' | 'warning'> {
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;
  const dbKey = isOperationalDeployment()
    ? serviceRoleKey
    : (serviceRoleKey ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

  if (!dbUrl || !dbKey) {
    return isOperationalDeployment() ? 'error' : 'warning';
  }

  try {
    const supabase = createClient(dbUrl, dbKey, {
      auth: { persistSession: false },
      global: {
        fetch: (url, options) =>
          fetch(url, { ...options, signal: AbortSignal.timeout(DB_CHECK_TIMEOUT_MS) }),
      },
    });

    if (isOperationalDeployment()) {
      const { getOAuthEnvironmentConfig } = await import('@/lib/oauth-server/identity-env');
      const expectedIdentity = getOAuthEnvironmentConfig();
      const expectedSupabaseProjectRef = resolveDatabaseOAuthProjectRef({
        environment: expectedIdentity.environment,
        supabaseUrl: dbUrl,
      });
      await assertDatabaseOAuthIdentity(
        expectedIdentity,
        () => supabase.rpc('get_mcp_environment_identity_v1'),
        expectedSupabaseProjectRef,
      );
    }

    const { error } = await supabase.from('profiles').select('id').limit(1);

    return error ? 'error' : 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Redis（Upstash）接続チェック
 */
async function checkRedis(): Promise<'ok' | 'error' | 'warning' | 'skipped'> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const isUpstashEnabled = Boolean(redisUrl && redisToken);

  if (!isUpstashEnabled) {
    return isOperationalDeployment() ? 'error' : 'skipped';
  }

  try {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({
      url: redisUrl!,
      token: redisToken!,
      // fetch レイヤの signal で下位 HTTP 呼び出し自体を abort する（Promise.race で
      // 見かけ上打ち切るだけだと裏の fetch が生き続け、Function の張り付きが解消しない）。
      signal: () => AbortSignal.timeout(REDIS_CHECK_TIMEOUT_MS),
    });

    const pong = await redis.ping();
    if (pong === 'PONG') return 'ok';
    return isOperationalDeployment() ? 'error' : 'warning';
  } catch {
    return 'error';
  }
}

/**
 * アプリケーションの稼働時間を取得
 */
function getUptime(): number {
  return process.uptime();
}

/**
 * アプリケーションバージョンを取得
 */
function getVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
}

/**
 * 環境名を取得
 */
function getEnvironment(): string {
  if (process.env.VERCEL_TARGET_ENV) {
    return process.env.VERCEL_TARGET_ENV;
  }

  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV;
  }

  return process.env.NODE_ENV || 'development';
}

/**
 * 本番環境かどうかを判定
 */
function isOperationalDeployment(): boolean {
  if (
    process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_TARGET_ENV === 'preview' &&
    process.env.MCP_OAUTH_ENVIRONMENT === 'preview'
  ) {
    return true;
  }
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production';

  return process.env.NODE_ENV === 'production';
}

/**
 * GET /api/health
 * ヘルスチェック実行
 *
 * 本番環境ではステータスのみ返す（情報露出防止）
 */
export async function GET() {
  const startTime = Date.now();

  try {
    const hasValidEnvironment = await hasValidOperationalEnvironment();
    if (!hasValidEnvironment) {
      logger.error('[health] environment check failed', {
        status: 'unhealthy',
        responseTimeMs: Date.now() - startTime,
      });
      return NextResponse.json(
        { status: 'unhealthy' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        },
      );
    }

    const [dbStatus, redisStatus] = await Promise.all([checkDatabase(), checkRedis()]);

    const overallStatus = resolveHealthStatus(['ok', dbStatus, redisStatus]);

    const httpStatus = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;
    const responseTime = Date.now() - startTime;

    if (overallStatus === 'unhealthy') {
      logger.error('[health] dependency check failed', {
        status: overallStatus,
        database: dbStatus,
        redis: redisStatus,
        responseTimeMs: responseTime,
      });
    } else if (overallStatus === 'degraded') {
      logger.warn('[health] dependency check degraded', {
        status: overallStatus,
        database: dbStatus,
        redis: redisStatus,
        responseTimeMs: responseTime,
      });
    }

    // 本番環境ではステータスのみ返す（内部情報の露出を防止）
    if (isOperationalDeployment()) {
      return NextResponse.json(
        { status: overallStatus },
        {
          status: httpStatus,
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        },
      );
    }

    const healthStatus: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: getUptime(),
      version: getVersion(),
      environment: getEnvironment(),
      checks: {
        database: dbStatus,
        redis: redisStatus,
      },
    };

    // エラーや警告の詳細を追加
    const warnings: string[] = [];
    if (dbStatus === 'warning') warnings.push('Database configuration incomplete');
    if (dbStatus === 'error') warnings.push('Database connection failed');
    if (redisStatus === 'warning') warnings.push('Redis connection degraded');
    if (redisStatus === 'error') warnings.push('Redis connection failed');

    if (warnings.length > 0) {
      healthStatus.details = { warnings };
    }

    // レスポンス時間をヘッダーに追加
    const response = NextResponse.json(healthStatus, { status: httpStatus });

    response.headers.set('X-Response-Time', `${responseTime}ms`);
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.headers.set('X-Health-Check-Version', '1.0');

    return response;
  } catch {
    const responseTime = Date.now() - startTime;

    logger.error('[health] check failed', {
      status: 'unhealthy',
      database: 'error',
      redis: 'error',
      responseTimeMs: responseTime,
    });

    // 本番環境ではエラー詳細を隠す
    if (isOperationalDeployment()) {
      return NextResponse.json({ status: 'unhealthy' }, { status: 503 });
    }

    // ヘルスチェック自体でエラーが発生した場合
    const errorStatus: HealthStatus = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: getUptime(),
      version: getVersion(),
      environment: getEnvironment(),
      checks: {
        database: 'error',
        redis: 'error',
      },
      details: {
        error: 'Health check failed',
      },
    };

    return NextResponse.json(errorStatus, { status: 503 });
  }
}
