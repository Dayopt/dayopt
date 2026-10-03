import 'server-only';

import { resolveDayoptEnvironment } from '@/lib/dayopt-environment';

/**
 * First-stage Supabase RPC adapter for the Redis replacement experiment.
 * Runtime adoption stays behind a fixed-Integration-only opt-in.
 */

export type SupabaseRateLimitPocClient = {
  rpc(
    functionName: string,
    args: Record<string, string | number>,
  ): PromiseLike<{ data: unknown; error: unknown | null }>;
};

type SupabaseRateLimitPocEnvironment = Record<string, string | undefined>;

/**
 * Preview deployments can share the Integration database, so URL-only detection is unsafe.
 * Each POC path requires its own explicit switch and this same fixed deployment identity.
 */
function isFixedIntegrationDeployment(environment: SupabaseRateLimitPocEnvironment): boolean {
  const dayoptEnvironment = resolveDayoptEnvironment({
    dayoptEnvironment: environment.DAYOPT_ENVIRONMENT,
    publicDayoptEnvironment: environment.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
    vercelEnvironment: environment.VERCEL_ENV,
    vercelTargetEnvironment: environment.VERCEL_TARGET_ENV,
    vercelProjectId: environment.VERCEL_PROJECT_ID,
    vercelGitCommitRef: environment.VERCEL_GIT_COMMIT_REF,
    vercelUrl: environment.VERCEL_URL,
    vercelBranchUrl: environment.VERCEL_BRANCH_URL,
    appUrl: environment.NEXT_PUBLIC_APP_URL,
    supabaseUrl: environment.NEXT_PUBLIC_SUPABASE_URL,
  });

  return dayoptEnvironment === 'integration';
}

export function isSupabaseRateLimitPocEnabled(
  environment: SupabaseRateLimitPocEnvironment = process.env,
): boolean {
  return (
    environment.SUPABASE_RATE_LIMIT_POC_ENABLED === 'true' &&
    isFixedIntegrationDeployment(environment)
  );
}

export function isSupabaseWebhookClaimPocEnabled(
  environment: SupabaseRateLimitPocEnvironment = process.env,
): boolean {
  return (
    environment.SUPABASE_WEBHOOK_CLAIM_POC_ENABLED === 'true' &&
    isFixedIntegrationDeployment(environment)
  );
}

type SupabaseRateLimitPocDecision = {
  allowed: boolean;
  remaining: number;
  estimatedCount: number;
  resetAt: Date;
  retryAfterSeconds: number;
};

export class SupabaseRateLimitPocUnavailableError extends Error {
  constructor() {
    super('Supabase rate-limit service is unavailable');
    this.name = 'SupabaseRateLimitPocUnavailableError';
  }
}

export class SupabaseWebhookClaimPocUnavailableError extends Error {
  constructor() {
    super('Supabase webhook claim service is unavailable');
    this.name = 'SupabaseWebhookClaimPocUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function assertDigest(value: string, label: string): void {
  if (!isDigest(value)) throw new TypeError(`${label} must be a lowercase SHA-256/HMAC digest`);
}

async function rpcOrThrow(
  client: SupabaseRateLimitPocClient,
  functionName: string,
  args: Record<string, string | number>,
  ErrorType: new () => Error,
): Promise<unknown> {
  try {
    const { data, error } = await client.rpc(functionName, args);
    if (error !== null) throw new Error('RPC failed');
    return data;
  } catch {
    // Keep provider responses, credentials, and database details out of user-facing errors.
    throw new ErrorType();
  }
}

export async function checkSupabaseRateLimitPoc(
  client: SupabaseRateLimitPocClient,
  input: {
    scope: string;
    identifierHash: string;
    limitCount: number;
    windowSeconds: number;
  },
): Promise<SupabaseRateLimitPocDecision> {
  assertDigest(input.identifierHash, 'identifierHash');
  const data = await rpcOrThrow(
    client,
    'check_supabase_rate_limit_poc',
    {
      p_scope: input.scope,
      p_identifier_hash: input.identifierHash,
      p_limit_count: input.limitCount,
      p_window_seconds: input.windowSeconds,
    },
    SupabaseRateLimitPocUnavailableError,
  );

  if (!isRecord(data)) throw new SupabaseRateLimitPocUnavailableError();
  const resetAt = typeof data.reset_at === 'string' ? new Date(data.reset_at) : null;
  if (
    typeof data.allowed !== 'boolean' ||
    !Number.isInteger(data.remaining) ||
    (data.remaining as number) < 0 ||
    typeof data.estimated_count !== 'number' ||
    !Number.isFinite(data.estimated_count) ||
    resetAt === null ||
    Number.isNaN(resetAt.getTime()) ||
    !Number.isInteger(data.retry_after_seconds) ||
    (data.retry_after_seconds as number) < 0
  ) {
    throw new SupabaseRateLimitPocUnavailableError();
  }

  return {
    allowed: data.allowed,
    remaining: data.remaining as number,
    estimatedCount: data.estimated_count,
    resetAt,
    retryAfterSeconds: data.retry_after_seconds as number,
  };
}

type SupabaseWebhookClaimPocStatus = 'claimed' | 'in_progress' | 'already_processed';

export async function claimSupabaseWebhookEventPoc(
  client: SupabaseRateLimitPocClient,
  eventHash: string,
  processingToken: string,
): Promise<SupabaseWebhookClaimPocStatus> {
  assertDigest(eventHash, 'eventHash');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(processingToken)) {
    throw new TypeError('processingToken must be a UUID');
  }

  const data = await rpcOrThrow(
    client,
    'claim_supabase_webhook_event_poc',
    { p_event_hash: eventHash, p_processing_token: processingToken },
    SupabaseWebhookClaimPocUnavailableError,
  );
  if (data === 'claimed' || data === 'in_progress' || data === 'already_processed') return data;
  throw new SupabaseWebhookClaimPocUnavailableError();
}

export async function completeSupabaseWebhookEventPoc(
  client: SupabaseRateLimitPocClient,
  eventHash: string,
  processingToken: string,
): Promise<boolean> {
  assertDigest(eventHash, 'eventHash');
  const data = await rpcOrThrow(
    client,
    'complete_supabase_webhook_event_poc',
    { p_event_hash: eventHash, p_processing_token: processingToken },
    SupabaseWebhookClaimPocUnavailableError,
  );
  if (typeof data !== 'boolean') throw new SupabaseWebhookClaimPocUnavailableError();
  return data;
}

export async function releaseSupabaseWebhookEventPoc(
  client: SupabaseRateLimitPocClient,
  eventHash: string,
  processingToken: string,
): Promise<boolean> {
  assertDigest(eventHash, 'eventHash');
  const data = await rpcOrThrow(
    client,
    'release_supabase_webhook_event_poc',
    { p_event_hash: eventHash, p_processing_token: processingToken },
    SupabaseWebhookClaimPocUnavailableError,
  );
  if (typeof data !== 'boolean') throw new SupabaseWebhookClaimPocUnavailableError();
  return data;
}
