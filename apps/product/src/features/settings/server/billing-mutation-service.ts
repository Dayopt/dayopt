import { isBillingEnforced } from '@/lib/billing/enforcement-flag';
import { dayoptProTrialDays } from '@dayopt/billing';
import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { env } from '@/env';
import { getAppUrl } from '@/lib/app-url';
import type { Database } from '@/lib/database';
import { requireStripe } from '@/lib/stripe/client';
import { ServiceError } from '@/lib/trpc/errors';

import { BILLING_OPERATION_SERVICE_CODES } from '../lib/billing-operation';

type BillingMutationKind = 'checkout' | 'portal';

type BillingMutationClaim =
  | {
      result: 'claimed';
      operationId: string;
      leaseId: string;
      leaseExpiresAt: string;
    }
  | {
      result: 'reconcile';
      operationId: string;
      providerRetryDeadlineAt: string;
    }
  | {
      result: 'completed';
      operationId: string;
      providerObjectId: string;
      responseExpiresAt: string;
      responseUrl: string;
    }
  | { result: 'response_expired'; operationId: string }
  | { result: 'abandoned'; operationId: string }
  | { result: 'contention' }
  | { result: 'account_closing' };

type CustomerProvisioningClaim =
  | { result: 'existing'; providerCustomerId: string }
  | { result: 'claimed'; leaseExpiresAt: string; leaseId: string }
  | { result: 'reconcile'; providerRetryDeadlineAt: string }
  | { result: 'recover'; providerRetryDeadlineAt: string };

type ProviderBillingClaim = Extract<BillingMutationClaim, { result: 'reconcile' }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;
const PORTAL_SESSION_ID_PATTERN = /^bps_[A-Za-z0-9_]+$/;
const PROVIDER_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const CHECKOUT_EXPIRY_AFTER_RETRY_MS = 45 * 60 * 1000;
const PROVIDER_START_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const STRIPE_PAGE_LIMIT = 100;
const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_]+$/;
const STRIPE_IDENTITY_TIMEOUT_MS = 5_000;
const BILLING_CLEANUP_TIMEOUT_MS = 4_000;

const IDEMPOTENCY_KEY_PREFIX = {
  checkout: 'dayopt-billing-checkout-v1',
  checkoutExpire: 'dayopt-billing-checkout-expire-v1',
  customer: 'dayopt-billing-customer-v1',
  portal: 'dayopt-billing-portal-v1',
} as const;

class BillingMutationError extends ServiceError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'BillingMutationError';
  }
}

function getConfiguredProPriceId(): string {
  const priceId = env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID?.trim();

  if (!priceId?.startsWith('price_')) {
    throw new BillingMutationError(
      'STRIPE_PRICE_NOT_CONFIGURED',
      'Stripe Pro price is not configured',
    );
  }

  return priceId;
}

async function assertStripeProviderIdentity(stripe: Stripe): Promise<void> {
  const accountId = env.STRIPE_ACCOUNT_ID?.trim();
  const livemode = env.STRIPE_LIVEMODE;
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const expectedSecretPrefix = livemode === 'true' ? 'sk_live_' : 'sk_test_';

  if (
    !accountId ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(accountId) ||
    (livemode !== 'true' && livemode !== 'false') ||
    !secretKey?.startsWith(expectedSecretPrefix)
  ) {
    throw new BillingMutationError(
      'STRIPE_IDENTITY_NOT_CONFIGURED',
      'Stripe provider identity is not configured',
    );
  }

  const account = await stripe.accounts.retrieve({
    maxNetworkRetries: 0,
    timeout: STRIPE_IDENTITY_TIMEOUT_MS,
  });
  if (account.id !== accountId) {
    throw new BillingMutationError(
      'STRIPE_IDENTITY_MISMATCH',
      'Stripe provider identity does not match',
    );
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSingleRow(value: unknown, contract: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw malformedContract(contract);
  }

  return value[0];
}

function requireString(value: unknown, contract: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw malformedContract(contract);
  }

  return value;
}

function requireUuid(value: unknown, contract: string): string {
  const parsed = requireString(value, contract);
  if (!UUID_PATTERN.test(parsed)) throw malformedContract(contract);
  return parsed;
}

function requireNullableUuid(value: unknown, contract: string): string | null {
  if (value === null) return null;
  return requireUuid(value, contract);
}

function requireTimestamp(value: unknown, contract: string): string {
  const parsed = requireString(value, contract);
  if (Number.isNaN(Date.parse(parsed))) throw malformedContract(contract);
  return parsed;
}

function requireNullableTimestamp(value: unknown, contract: string): string | null {
  if (value === null) return null;
  return requireTimestamp(value, contract);
}

function requireProviderObjectId(
  value: unknown,
  kind: BillingMutationKind,
  contract: string,
): string {
  const parsed = requireString(value, contract);
  const pattern = kind === 'checkout' ? CHECKOUT_SESSION_ID_PATTERN : PORTAL_SESSION_ID_PATTERN;
  if (!pattern.test(parsed)) throw malformedContract(contract);
  return parsed;
}

function requireNullableProviderObjectId(
  value: unknown,
  kind: BillingMutationKind,
  contract: string,
): string | null {
  if (value === null) return null;
  return requireProviderObjectId(value, kind, contract);
}

function requireCustomerId(value: unknown, contract: string): string {
  const parsed = requireString(value, contract);
  if (!CUSTOMER_ID_PATTERN.test(parsed)) throw malformedContract(contract);
  return parsed;
}

function requireNullableCustomerId(value: unknown, contract: string): string | null {
  if (value === null) return null;
  return requireCustomerId(value, contract);
}

function requireProviderUrl(value: unknown, kind: BillingMutationKind, contract: string): string {
  const parsed = requireString(value, contract);

  try {
    const url = new URL(parsed);
    const expectedHost = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
    if (
      url.protocol !== 'https:' ||
      url.hostname !== expectedHost ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw malformedContract(contract);
    }
  } catch (error) {
    if (error instanceof BillingMutationError) throw error;
    throw malformedContract(contract);
  }

  return parsed;
}

function requireNullableProviderUrl(
  value: unknown,
  kind: BillingMutationKind,
  contract: string,
): string | null {
  if (value === null) return null;
  return requireProviderUrl(value, kind, contract);
}

function malformedContract(contract: string): BillingMutationError {
  return new BillingMutationError(
    'BILLING_CONTRACT_INVALID',
    `Billing contract was malformed: ${contract}`,
  );
}

function assertProviderRetryWindow(providerRetryDeadlineAt: string): void {
  if (Date.parse(providerRetryDeadlineAt) <= Date.now() + PROVIDER_START_SAFETY_MARGIN_MS) {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.operationConflict,
      'The provider retry window is closing. Try the action again.',
    );
  }
}

function parseBillingMutationClaim(
  value: unknown,
  kind: BillingMutationKind,
): BillingMutationClaim {
  const row = requireSingleRow(value, 'billing mutation claim row');
  const result = requireString(row.result, 'billing mutation claim result');
  const operationId = requireNullableUuid(
    row.canonical_operation_id,
    'billing mutation operation id',
  );
  const leaseId = requireNullableUuid(row.lease_id, 'billing mutation lease id');
  const leaseExpiresAt = requireNullableTimestamp(
    row.lease_expires_at,
    'billing mutation lease expiry',
  );
  const providerRetryDeadlineAt = requireNullableTimestamp(
    row.provider_retry_deadline_at,
    'billing mutation provider retry deadline',
  );
  const providerObjectId = requireNullableProviderObjectId(
    row.provider_object_id,
    kind,
    'billing mutation provider object',
  );
  const responseUrl = requireNullableProviderUrl(
    row.provider_response_url,
    kind,
    'billing mutation response URL',
  );
  const responseExpiresAt = requireNullableTimestamp(
    row.provider_response_expires_at,
    'billing mutation response expiry',
  );

  if (result === 'contention') {
    if (
      operationId !== null ||
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt !== null ||
      providerObjectId !== null ||
      responseUrl !== null ||
      responseExpiresAt !== null
    ) {
      throw malformedContract('billing mutation contention shape');
    }
    return { result };
  }

  if (result === 'account_closing') {
    if (responseUrl !== null || responseExpiresAt !== null) {
      throw malformedContract('billing mutation account-closing shape');
    }
    return { result };
  }

  if (operationId === null) {
    throw malformedContract('billing mutation canonical operation');
  }

  if (result === 'claimed') {
    if (
      leaseId === null ||
      leaseExpiresAt === null ||
      providerRetryDeadlineAt !== null ||
      providerObjectId !== null ||
      responseUrl !== null ||
      responseExpiresAt !== null
    ) {
      throw malformedContract('billing mutation claimed shape');
    }
    return { leaseExpiresAt, leaseId, operationId, result };
  }

  if (result === 'reconcile') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt === null ||
      providerObjectId !== null ||
      responseUrl !== null ||
      responseExpiresAt !== null
    ) {
      throw malformedContract('billing mutation reconcile shape');
    }
    return { operationId, providerRetryDeadlineAt, result };
  }

  if (result === 'completed') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt === null ||
      providerObjectId === null ||
      responseUrl === null ||
      responseExpiresAt === null
    ) {
      throw malformedContract('billing mutation completed shape');
    }
    return {
      operationId,
      providerObjectId,
      responseExpiresAt,
      responseUrl,
      result,
    };
  }

  if (result === 'response_expired') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt === null ||
      providerObjectId === null ||
      responseUrl !== null ||
      responseExpiresAt !== null
    ) {
      throw malformedContract('billing mutation expired-response shape');
    }
    return { operationId, result };
  }

  if (result === 'abandoned') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerObjectId !== null ||
      responseUrl !== null ||
      responseExpiresAt !== null
    ) {
      throw malformedContract('billing mutation abandoned shape');
    }
    return { operationId, result };
  }

  throw malformedContract('billing mutation result');
}

function parseCustomerProvisioningClaim(value: unknown): CustomerProvisioningClaim {
  const row = requireSingleRow(value, 'Customer provisioning claim row');
  const result = requireString(row.result, 'Customer provisioning result');
  const leaseId = requireNullableUuid(row.lease_id, 'Customer provisioning lease id');
  const leaseExpiresAt = requireNullableTimestamp(
    row.lease_expires_at,
    'Customer provisioning lease expiry',
  );
  const providerRetryDeadlineAt = requireNullableTimestamp(
    row.provider_retry_deadline_at,
    'Customer provisioning retry deadline',
  );
  const providerCustomerId = requireNullableCustomerId(
    row.provider_customer_id,
    'Customer provisioning provider id',
  );

  if (result === 'existing') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt !== null ||
      providerCustomerId === null
    ) {
      throw malformedContract('Customer provisioning existing shape');
    }
    return { providerCustomerId, result };
  }

  if (result === 'claimed') {
    if (
      leaseId === null ||
      leaseExpiresAt === null ||
      providerRetryDeadlineAt !== null ||
      providerCustomerId !== null
    ) {
      throw malformedContract('Customer provisioning claimed shape');
    }
    return { leaseExpiresAt, leaseId, result };
  }

  if (result === 'reconcile' || result === 'recover') {
    if (
      leaseId !== null ||
      leaseExpiresAt !== null ||
      providerRetryDeadlineAt === null ||
      providerCustomerId !== null
    ) {
      throw malformedContract(`Customer provisioning ${result} shape`);
    }
    return { providerRetryDeadlineAt, result };
  }

  throw malformedContract('Customer provisioning result');
}

function getDatabaseErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function throwDatabaseCommandError(
  error: unknown,
  operation: string,
  options: { accountClosingOnAd019?: boolean } = {},
): never {
  const databaseCode = getDatabaseErrorCode(error);

  if (databaseCode === 'AD004' || databaseCode === 'AD014') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.operationInvalidated,
      'Billing details changed. Start the action again.',
      { cause: error instanceof Error ? error : undefined },
    );
  }

  if (databaseCode === 'AD019') {
    throw new BillingMutationError(
      options.accountClosingOnAd019
        ? BILLING_OPERATION_SERVICE_CODES.accountClosing
        : BILLING_OPERATION_SERVICE_CODES.operationConflict,
      options.accountClosingOnAd019
        ? 'Account deletion is in progress.'
        : 'Another billing action is still in progress. Try again.',
      { cause: error instanceof Error ? error : undefined },
    );
  }

  throw new BillingMutationError('BILLING_COMMAND_FAILED', `Billing command failed: ${operation}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

async function getProfileCustomerId(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();

  if (error) throwDatabaseCommandError(error, 'get_profile_customer');
  if (!data) throw malformedContract('billing profile');

  return data.stripe_customer_id === null
    ? null
    : requireCustomerId(data.stripe_customer_id, 'profile Customer id');
}

async function claimBillingMutation(
  supabase: SupabaseClient<Database>,
  input: {
    digest: string;
    kind: BillingMutationKind;
    operationId: string;
    userId: string;
  },
): Promise<BillingMutationClaim> {
  const { data, error } = await supabase.rpc('claim_billing_mutation_v3', {
    p_mutation_kind: input.kind,
    p_operation_id: input.operationId,
    p_request_digest: input.digest,
    p_user_id: input.userId,
  });

  if (error) {
    throwDatabaseCommandError(error, 'claim_billing_mutation', {
      accountClosingOnAd019: true,
    });
  }

  return parseBillingMutationClaim(data, input.kind);
}

function getTerminalResponse(claim: BillingMutationClaim): string | null {
  if (claim.result === 'completed') return claim.responseUrl;

  if (claim.result === 'response_expired') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.responseExpired,
      'This billing link expired. Start the action again.',
    );
  }

  if (claim.result === 'account_closing') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.accountClosing,
      'Account deletion is in progress.',
    );
  }

  if (claim.result === 'abandoned') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.recoveryExhausted,
      'The previous billing action could not be recovered. Start again.',
    );
  }

  if (claim.result === 'contention') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.operationConflict,
      'Another billing action is still in progress. Try again.',
    );
  }

  return null;
}

async function startBillingMutation(
  supabase: SupabaseClient<Database>,
  input: {
    claim: Extract<BillingMutationClaim, { result: 'claimed' }>;
    customerId: string;
    digest: string;
    kind: BillingMutationKind;
    userId: string;
  },
): Promise<ProviderBillingClaim | { completedUrl: string }> {
  const { data, error } = await supabase.rpc('start_billing_mutation_v2', {
    p_lease_id: input.claim.leaseId,
    p_operation_id: input.claim.operationId,
    p_provider_customer_id: input.customerId,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'start_billing_mutation');

  const startResult = requireString(data, 'billing mutation start result');
  if (startResult === 'superseded') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.operationConflict,
      'Another billing action acquired this operation. Try again.',
    );
  }
  if (
    startResult !== 'started' &&
    startResult !== 'reconcile' &&
    startResult !== 'completed' &&
    startResult !== 'abandoned' &&
    startResult !== 'retry_expired'
  ) {
    throw malformedContract('billing mutation start result');
  }

  const replay = await claimBillingMutation(supabase, {
    digest: input.digest,
    kind: input.kind,
    operationId: input.claim.operationId,
    userId: input.userId,
  });
  const completedUrl = getTerminalResponse(replay);
  if (completedUrl !== null) return { completedUrl };
  if (replay.result !== 'reconcile') {
    throw malformedContract('billing mutation provider-start replay');
  }

  return replay;
}

async function claimCustomerProvisioning(
  supabase: SupabaseClient<Database>,
  input: { emailDigest: string; operationId: string; userId: string },
): Promise<CustomerProvisioningClaim> {
  const { data, error } = await supabase.rpc('claim_billing_customer_provisioning_v2', {
    p_email_digest: input.emailDigest,
    p_operation_id: input.operationId,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'claim_billing_customer_provisioning');
  return parseCustomerProvisioningClaim(data);
}

async function startCustomerProvisioning(
  supabase: SupabaseClient<Database>,
  input: { leaseId: string; operationId: string; userId: string },
): Promise<'reconcile' | 'recover' | 'started'> {
  const { data, error } = await supabase.rpc('start_billing_customer_provisioning_v2', {
    p_lease_id: input.leaseId,
    p_operation_id: input.operationId,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'start_billing_customer_provisioning');

  const result = requireString(data, 'Customer provisioning start result');
  if (result === 'superseded') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.operationConflict,
      'Another Customer provisioning action acquired this operation. Try again.',
    );
  }
  if (result !== 'started' && result !== 'reconcile' && result !== 'recover') {
    throw malformedContract('Customer provisioning start result');
  }
  return result;
}

async function completeCustomerProvisioning(
  supabase: SupabaseClient<Database>,
  input: { customerId: string; operationId: string; userId: string },
): Promise<string> {
  const { data, error } = await supabase.rpc('complete_billing_customer_provisioning_v2', {
    p_operation_id: input.operationId,
    p_provider_customer_id: input.customerId,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'complete_billing_customer_provisioning');

  const completedCustomerId = requireCustomerId(data, 'completed Customer id');
  if (completedCustomerId !== input.customerId) {
    throw malformedContract('completed Customer binding');
  }
  return completedCustomerId;
}

async function abandonCustomerProvisioning(
  supabase: SupabaseClient<Database>,
  input: { operationId: string; userId: string },
): Promise<never> {
  const { data, error } = await supabase.rpc('abandon_billing_customer_provisioning_v2', {
    p_operation_id: input.operationId,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'abandon_billing_customer_provisioning');
  if (data !== true) throw malformedContract('Customer provisioning abandon result');

  throw new BillingMutationError(
    BILLING_OPERATION_SERVICE_CODES.recoveryExhausted,
    'The Customer creation response could not be recovered. Start again.',
  );
}

async function findUniqueProvisionedCustomer(
  stripe: Stripe,
  email: string,
  userId: string,
): Promise<Stripe.Customer | null> {
  let startingAfter: string | undefined;
  let found: Stripe.Customer | null = null;

  while (true) {
    const page = await stripe.customers.list({
      email,
      limit: STRIPE_PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const customer of page.data) {
      if (customer.metadata.supabase_user_id !== userId) continue;
      if (found && found.id !== customer.id) {
        throw new BillingMutationError(
          'BILLING_CUSTOMER_AMBIGUOUS',
          'Multiple Stripe customers are bound to this account.',
        );
      }
      found = customer;
    }

    if (!page.has_more) return found;

    const lastCustomer = page.data.at(-1);
    if (!lastCustomer) throw malformedContract('Stripe Customer pagination');
    startingAfter = lastCustomer.id;
  }
}

async function resolveCheckoutCustomer(
  stripe: Stripe,
  supabase: SupabaseClient<Database>,
  input: {
    email: string;
    operationId: string;
    profileCustomerId: string | null;
    userId: string;
  },
): Promise<string> {
  if (input.profileCustomerId) return input.profileCustomerId;

  const claim = await claimCustomerProvisioning(supabase, {
    emailDigest: digest(['billing-customer-email-v1', input.email]),
    operationId: input.operationId,
    userId: input.userId,
  });

  if (claim.result === 'existing') return claim.providerCustomerId;

  let providerState: 'reconcile' | 'recover' | 'started';

  if (claim.result === 'claimed') {
    providerState = await startCustomerProvisioning(supabase, {
      leaseId: claim.leaseId,
      operationId: input.operationId,
      userId: input.userId,
    });
  } else {
    providerState = claim.result;
  }

  const recoveredCustomer = await findUniqueProvisionedCustomer(stripe, input.email, input.userId);

  if (recoveredCustomer) {
    return completeCustomerProvisioning(supabase, {
      customerId: recoveredCustomer.id,
      operationId: input.operationId,
      userId: input.userId,
    });
  }

  if (providerState === 'recover') {
    return abandonCustomerProvisioning(supabase, {
      operationId: input.operationId,
      userId: input.userId,
    });
  }

  const latestClaim = await claimCustomerProvisioning(supabase, {
    emailDigest: digest(['billing-customer-email-v1', input.email]),
    operationId: input.operationId,
    userId: input.userId,
  });
  if (latestClaim.result === 'existing') return latestClaim.providerCustomerId;
  if (latestClaim.result === 'recover') {
    return abandonCustomerProvisioning(supabase, {
      operationId: input.operationId,
      userId: input.userId,
    });
  }
  if (latestClaim.result !== 'reconcile') {
    throw malformedContract('Customer provisioning pre-provider recheck');
  }
  assertProviderRetryWindow(latestClaim.providerRetryDeadlineAt);

  const customer = await stripe.customers.create(
    {
      email: input.email,
      metadata: {
        supabase_user_id: input.userId,
      },
    },
    {
      idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX.customer}-${input.operationId}`,
    },
  );
  const customerId = requireCustomerId(customer.id, 'created Stripe Customer id');

  return completeCustomerProvisioning(supabase, {
    customerId,
    operationId: input.operationId,
    userId: input.userId,
  });
}

async function listOpenCheckoutSessions(
  stripe: Stripe,
  customerId: string,
): Promise<Stripe.Checkout.Session[]> {
  const sessions: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: STRIPE_PAGE_LIMIT,
      status: 'open',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);

    if (!page.has_more) return sessions;

    const lastSession = page.data.at(-1);
    if (!lastSession) throw malformedContract('Stripe Checkout pagination');
    startingAfter = lastSession.id;
  }
}

async function expirePreviousCheckoutSessions(
  stripe: Stripe,
  input: {
    allowCreate: boolean;
    customerId: string;
    operationId: string;
    providerRetryDeadlineAt: string;
    userId: string;
  },
): Promise<Stripe.Checkout.Session | null> {
  const sessions = await listOpenCheckoutSessions(stripe, input.customerId);
  let currentSession: Stripe.Checkout.Session | null = null;

  for (const session of sessions) {
    if (session.metadata?.supabase_user_id !== input.userId) continue;

    if (session.metadata.dayopt_operation_id === input.operationId) {
      if (currentSession && currentSession.id !== session.id) {
        throw new BillingMutationError(
          'BILLING_SESSION_AMBIGUOUS',
          'Multiple Checkout sessions exist for this billing operation.',
        );
      }
      currentSession = session;
    }
  }

  for (const session of sessions) {
    if (
      session.metadata?.supabase_user_id !== input.userId ||
      (input.allowCreate && session.id === currentSession?.id)
    ) {
      continue;
    }

    assertProviderRetryWindow(input.providerRetryDeadlineAt);
    await stripe.checkout.sessions.expire(
      session.id,
      {},
      {
        idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX.checkoutExpire}-${session.id}`,
      },
    );
  }

  return currentSession;
}

function getCheckoutExpiresAt(providerRetryDeadlineAt: string): number {
  const retryDeadlineMs = Date.parse(providerRetryDeadlineAt);
  const providerStartedAt = retryDeadlineMs - PROVIDER_RETRY_WINDOW_MS;
  const expiresAt = providerStartedAt + PROVIDER_RETRY_WINDOW_MS + CHECKOUT_EXPIRY_AFTER_RETRY_MS;
  return Math.floor(expiresAt / 1000);
}

async function reconcileBillingMutation(
  supabase: SupabaseClient<Database>,
  input: {
    customerId: string;
    kind: BillingMutationKind;
    operationId: string;
    outcome: 'completed' | 'not_created';
    providerObjectId: string | null;
    responseUrl: string | null;
    userId: string;
  },
): Promise<'abandoned' | 'completed'> {
  const { data, error } = await supabase.rpc('reconcile_billing_mutation_v4', {
    p_operation_id: input.operationId,
    p_outcome: input.outcome,
    p_provider_customer_id: input.customerId,
    p_provider_object_id: input.providerObjectId as never,
    p_provider_response_url: input.responseUrl as never,
    p_user_id: input.userId,
  });

  if (error) throwDatabaseCommandError(error, 'reconcile_billing_mutation');

  const result = requireString(data, 'billing mutation reconciliation result');
  if (result === 'completed') return result;

  if (result === 'response_expired') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.responseExpired,
      'This billing link expired. Start the action again.',
    );
  }
  if (result === 'account_closing') {
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.accountClosing,
      'Account deletion is in progress.',
    );
  }
  if (result === 'abandoned') {
    if (input.outcome === 'not_created') return result;
    throw new BillingMutationError(
      BILLING_OPERATION_SERVICE_CODES.recoveryExhausted,
      'The billing provider response could not be committed. Start again.',
    );
  }

  throw malformedContract('billing mutation reconciliation result');
}

interface CheckoutSubscriptionState {
  hasBlockingSubscription: boolean;
  hasTrialHistory: boolean;
}

async function getSubscriptionState(
  stripe: Stripe,
  customerId: string,
): Promise<CheckoutSubscriptionState> {
  let startingAfter: string | undefined;
  let hasBlockingSubscription = false;
  let hasTrialHistory = false;

  while (true) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      limit: STRIPE_PAGE_LIMIT,
      status: 'all',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const subscription of page.data) {
      hasTrialHistory = true;
      if (subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired') {
        hasBlockingSubscription = true;
      }
    }

    if (!page.has_more) {
      return { hasBlockingSubscription, hasTrialHistory };
    }

    const lastSubscription = page.data.at(-1);
    if (!lastSubscription) throw malformedContract('Stripe Subscription pagination');
    startingAfter = lastSubscription.id;
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new BillingMutationError('BILLING_EMAIL_REQUIRED', 'A billing email is required.');
  }
  return normalized;
}

async function getProviderClaim(
  supabase: SupabaseClient<Database>,
  input: {
    claim: Extract<BillingMutationClaim, { result: 'claimed' | 'reconcile' }>;
    customerId: string;
    digest: string;
    kind: BillingMutationKind;
    userId: string;
  },
): Promise<ProviderBillingClaim | { completedUrl: string }> {
  if (input.claim.result === 'reconcile') return input.claim;
  return startBillingMutation(supabase, {
    claim: input.claim,
    customerId: input.customerId,
    digest: input.digest,
    kind: input.kind,
    userId: input.userId,
  });
}

async function createCheckoutProviderSession(
  stripe: Stripe,
  supabase: SupabaseClient<Database>,
  input: {
    appUrl: string;
    allowCreate: boolean;
    customerId: string;
    hasTrialHistory: boolean;
    operationId: string;
    priceId: string;
    providerRetryDeadlineAt: string;
    userId: string;
  },
): Promise<string> {
  const currentSession = await expirePreviousCheckoutSessions(stripe, {
    allowCreate: input.allowCreate,
    customerId: input.customerId,
    operationId: input.operationId,
    providerRetryDeadlineAt: input.providerRetryDeadlineAt,
    userId: input.userId,
  });

  let session: Stripe.Checkout.Session | null =
    input.allowCreate &&
    currentSession?.url &&
    currentSession.status === 'open' &&
    CHECKOUT_SESSION_ID_PATTERN.test(currentSession.id)
      ? currentSession
      : null;

  if (!session && input.allowCreate) {
    assertProviderRetryWindow(input.providerRetryDeadlineAt);
    session = await stripe.checkout.sessions.create(
      {
        cancel_url: `${input.appUrl}/settings/billing?canceled=true`,
        client_reference_id: input.operationId,
        customer: input.customerId,
        expires_at: getCheckoutExpiresAt(input.providerRetryDeadlineAt),
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata: {
          dayopt_operation_id: input.operationId,
          supabase_user_id: input.userId,
        },
        mode: 'subscription',
        ...(isBillingEnforced() ? { payment_method_types: ['card' as const] } : {}),
        ...(!isBillingEnforced() && !input.hasTrialHistory
          ? {
              subscription_data: {
                trial_period_days: dayoptProTrialDays,
              },
            }
          : {}),
        success_url: `${input.appUrl}/settings/billing?success=true`,
      },
      {
        idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX.checkout}-${input.operationId}`,
      },
    );
  }

  if (
    !session ||
    session.status !== 'open' ||
    !session.url ||
    !CHECKOUT_SESSION_ID_PATTERN.test(session.id)
  ) {
    await reconcileBillingMutation(supabase, {
      customerId: input.customerId,
      kind: 'checkout',
      operationId: input.operationId,
      outcome: 'not_created',
      providerObjectId: null,
      responseUrl: null,
      userId: input.userId,
    });
    if (!input.allowCreate) {
      throw new BillingMutationError(
        BILLING_OPERATION_SERVICE_CODES.checkoutNotAvailable,
        'An existing subscription must be managed from the billing portal.',
      );
    }
    throw malformedContract('usable Stripe Checkout session');
  }
  const responseUrl = requireProviderUrl(session.url, 'checkout', 'Stripe Checkout Session URL');

  await reconcileBillingMutation(supabase, {
    customerId: input.customerId,
    kind: 'checkout',
    operationId: input.operationId,
    outcome: 'completed',
    providerObjectId: session.id,
    responseUrl,
    userId: input.userId,
  });

  return responseUrl;
}

export async function createCheckoutSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  email: string,
  operationId: string,
): Promise<string> {
  const stripe = requireStripe();
  const normalizedEmail = normalizeEmail(email);
  const priceId = getConfiguredProPriceId();
  const appUrl = getAppUrl();
  const profileCustomerId = await getProfileCustomerId(supabase, userId);
  const requestDigest = digest(['billing-checkout-v1', normalizedEmail, priceId, appUrl]);

  const claim = await claimBillingMutation(supabase, {
    digest: requestDigest,
    kind: 'checkout',
    operationId,
    userId,
  });
  const completedUrl = getTerminalResponse(claim);
  if (completedUrl !== null) return completedUrl;
  if (claim.result !== 'claimed' && claim.result !== 'reconcile') {
    throw malformedContract('actionable Checkout claim');
  }
  await assertStripeProviderIdentity(stripe);

  const customerId =
    claim.result === 'reconcile'
      ? profileCustomerId
      : await resolveCheckoutCustomer(stripe, supabase, {
          email: normalizedEmail,
          operationId: claim.operationId,
          profileCustomerId,
          userId,
        });
  if (!customerId) throw malformedContract('Checkout provider Customer binding');
  const subscriptionState = await getSubscriptionState(stripe, customerId);

  const providerClaim = await getProviderClaim(supabase, {
    claim,
    customerId,
    digest: requestDigest,
    kind: 'checkout',
    userId,
  });
  if ('completedUrl' in providerClaim) return providerClaim.completedUrl;

  return createCheckoutProviderSession(stripe, supabase, {
    allowCreate: !subscriptionState.hasBlockingSubscription,
    appUrl,
    customerId,
    hasTrialHistory: subscriptionState.hasTrialHistory,
    operationId: providerClaim.operationId,
    priceId,
    providerRetryDeadlineAt: providerClaim.providerRetryDeadlineAt,
    userId,
  });
}

export async function createPortalSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  operationId: string,
): Promise<string> {
  const stripe = requireStripe();
  const appUrl = getAppUrl();
  const customerId = await getProfileCustomerId(supabase, userId);

  if (!customerId) {
    throw new BillingMutationError(
      'NOT_FOUND',
      'No Stripe customer found. Subscribe to Pro first.',
    );
  }

  const requestDigest = digest(['billing-portal-v1', customerId, appUrl]);
  const claim = await claimBillingMutation(supabase, {
    digest: requestDigest,
    kind: 'portal',
    operationId,
    userId,
  });
  const completedUrl = getTerminalResponse(claim);
  if (completedUrl !== null) return completedUrl;
  if (claim.result !== 'claimed' && claim.result !== 'reconcile') {
    throw malformedContract('actionable Portal claim');
  }
  await assertStripeProviderIdentity(stripe);

  const providerClaim = await getProviderClaim(supabase, {
    claim,
    customerId,
    digest: requestDigest,
    kind: 'portal',
    userId,
  });
  if ('completedUrl' in providerClaim) return providerClaim.completedUrl;

  assertProviderRetryWindow(providerClaim.providerRetryDeadlineAt);
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: customerId,
      return_url: `${appUrl}/settings/billing?portal_return=true`,
    },
    {
      idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX.portal}-${providerClaim.operationId}`,
    },
  );
  const providerObjectId = requireProviderObjectId(
    session.id,
    'portal',
    'Stripe Portal Session id',
  );
  const responseUrl = requireProviderUrl(session.url, 'portal', 'Stripe Portal Session URL');

  await reconcileBillingMutation(supabase, {
    customerId,
    kind: 'portal',
    operationId: providerClaim.operationId,
    outcome: 'completed',
    providerObjectId,
    responseUrl,
    userId,
  });

  return responseUrl;
}

export async function cleanupBillingMutationClaims(
  db: SupabaseClient<Database>,
  input: { limit: number },
): Promise<
  Readonly<{
    claimsDeleted: number;
    hasMore: boolean;
    providerResponsesRedacted: number;
  }>
> {
  const { data, error } = await db
    .rpc('cleanup_billing_mutation_claims_v2', { p_limit: input.limit })
    .abortSignal(AbortSignal.timeout(BILLING_CLEANUP_TIMEOUT_MS));
  const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (
    error ||
    row == null ||
    !Number.isInteger(row.claims_deleted) ||
    row.claims_deleted < 0 ||
    !Number.isInteger(row.provider_responses_redacted) ||
    row.provider_responses_redacted < 0 ||
    typeof row.has_more !== 'boolean'
  ) {
    throw new BillingMutationError('CLEANUP_FAILED', 'Billing mutation cleanup failed', {
      cause: error ?? undefined,
    });
  }
  return {
    claimsDeleted: row.claims_deleted,
    hasMore: row.has_more,
    providerResponsesRedacted: row.provider_responses_redacted,
  };
}

export { BillingMutationError };
