import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const TEST_PASSWORD = 'account-gate-password';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const CUSTOMER_EMAIL_DIGEST = 'c'.repeat(64);

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const lifecycleUserClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const gateFirstUserClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const lifecycleUserId = crypto.randomUUID();
const billingUserId = crypto.randomUUID();
const gateFirstUserId = crypto.randomUUID();
const customerProvisioningUserId = crypto.randomUUID();
const customerRecoveryUserId = crypto.randomUUID();
const customerAbandonUserId = crypto.randomUUID();
const userIds = [
  lifecycleUserId,
  billingUserId,
  gateFirstUserId,
  customerProvisioningUserId,
  customerRecoveryUserId,
  customerAbandonUserId,
];

function psqlArgs(variables: Record<string, string> = {}): string[] {
  return [
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
    ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
    '-h',
    '127.0.0.1',
    '-p',
    '54322',
    '-U',
    'postgres',
    '-d',
    'postgres',
  ];
}

function psqlEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: 'postgres' };
}

function ownerSql(
  sql: string,
  variables: Record<string, string> = {},
): { stderr: string; stdout: string } {
  const result = spawnSync('psql', psqlArgs(variables), {
    encoding: 'utf8',
    env: psqlEnv(),
    input: sql,
  });

  if (result.status !== 0) {
    throw new Error(`Account deletion gate SQL failed: ${result.stderr}`);
  }

  return { stderr: result.stderr, stdout: result.stdout.trim() };
}

function expectOwnerSqlFailure(
  sql: string,
  expectedSqlState: string,
  variables: Record<string, string> = {},
): void {
  const result = spawnSync('psql', psqlArgs(variables), {
    encoding: 'utf8',
    env: psqlEnv(),
    input: `\\set VERBOSITY verbose\n${sql}`,
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(expectedSqlState);
}

function setGateActivation(active: boolean): void {
  ownerSql(
    `UPDATE private.account_deletion_control
SET activation_version = CASE WHEN :'active'::BOOLEAN THEN 1 ELSE 0 END,
    activated_at = CASE
      WHEN :'active'::BOOLEAN THEN pg_catalog.clock_timestamp()
      ELSE NULL
    END
WHERE singleton;`,
    { active: String(active) },
  );
}

function requireString(value: null | string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} was not returned`);
  }
  return value;
}

async function createUser(userId: string): Promise<void> {
  const { error } = await admin.auth.admin.createUser({
    id: userId,
    email: `account-gate-${userId}@example.com`,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
}

async function begin(userId: string) {
  const { data, error } = await admin.rpc('begin_account_deletion_v1', {
    p_user_id: userId,
  });
  if (error) throw error;
  const operation = data?.[0];
  if (!operation) throw new Error('Account deletion begin returned no operation');
  return operation;
}

async function bindCalendar(userId: string, deletionId: string) {
  const { data, error } = await admin.rpc('bind_calendar_account_deletion_v1', {
    p_generic_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (error) throw error;
  const binding = data?.[0];
  if (!binding) throw new Error('Calendar account deletion binding returned no row');
  return binding;
}

async function bindBilling(userId: string, deletionId: string) {
  const { data, error } = await admin.rpc('bind_billing_account_deletion_v1', {
    p_generic_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (error) throw error;
  const binding = data?.[0];
  if (!binding) throw new Error('Billing account deletion binding returned no row');
  return binding;
}

async function claimStep(userId: string, deletionId: string, step: string) {
  const { data, error } = await admin.rpc('claim_account_deletion_step_v1', {
    p_deletion_id: deletionId,
    p_step: step,
    p_user_id: userId,
  });
  if (error) throw error;
  const claim = data?.[0];
  if (!claim) throw new Error('Account deletion step claim returned no row');
  return claim;
}

async function completeStep(
  userId: string,
  deletionId: string,
  step: string,
  leaseId: string,
): Promise<void> {
  const { data, error } = await admin.rpc('complete_account_deletion_step_v1', {
    p_deletion_id: deletionId,
    p_lease_id: leaseId,
    p_step: step,
    p_user_id: userId,
  });
  if (error) throw error;
  expect(data).toBe(true);
}

async function completeNoSourceCalendar(userId: string, deletionId: string): Promise<void> {
  const binding = await bindCalendar(userId, deletionId);
  expect(binding.calendar_required).toBe(false);
  expect(binding.calendar_deletion_id).not.toBe(deletionId);

  const claim = await claimStep(userId, deletionId, 'calendar');
  await completeStep(
    userId,
    deletionId,
    'calendar',
    requireString(claim.lease_id, 'Calendar step lease'),
  );
}

async function completeStorage(userId: string, deletionId: string): Promise<void> {
  const claim = await claimStep(userId, deletionId, 'storage');
  await completeStep(
    userId,
    deletionId,
    'storage',
    requireString(claim.lease_id, 'Storage step lease'),
  );
}

async function completeBilling(userId: string, deletionId: string): Promise<void> {
  const claim = await claimStep(userId, deletionId, 'billing');
  await completeStep(
    userId,
    deletionId,
    'billing',
    requireString(claim.lease_id, 'Billing step lease'),
  );
}

async function sealGeneric(userId: string, deletionId: string): Promise<void> {
  const { data, error } = await admin.rpc('seal_account_deletion_v1', {
    p_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (error) throw error;
  expect(data).toBe(true);
}

describe.skipIf(!RUN_LOCAL)('generic account deletion gate', () => {
  beforeAll(async () => {
    setGateActivation(false);
    for (const userId of userIds) await createUser(userId);

    const [{ error: lifecycleSignInError }, { error: gateFirstSignInError }] = await Promise.all([
      lifecycleUserClient.auth.signInWithPassword({
        email: `account-gate-${lifecycleUserId}@example.com`,
        password: TEST_PASSWORD,
      }),
      gateFirstUserClient.auth.signInWithPassword({
        email: `account-gate-${gateFirstUserId}@example.com`,
        password: TEST_PASSWORD,
      }),
    ]);
    if (lifecycleSignInError) throw lifecycleSignInError;
    if (gateFirstSignInError) throw gateFirstSignInError;
  });

  afterAll(async () => {
    setGateActivation(false);
    await lifecycleUserClient.auth.signOut();
    await gateFirstUserClient.auth.signOut();

    for (const userId of userIds) {
      ownerSql(
        `DELETE FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.billing_mutation_claims
WHERE user_id = :'user_id'::UUID;`,
        { user_id: userId },
      );
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it('fails closed while inactive or when the activation singleton is removed', async () => {
    setGateActivation(false);

    const { data: readiness, error: readinessError } = await admin.rpc(
      'get_account_deletion_readiness_v1',
    );
    expect(readinessError).toBeNull();
    expect(readiness?.[0]).toEqual({
      activated: false,
      active_operations: 0,
    });

    const { error: inactiveBeginError } = await admin.rpc('begin_account_deletion_v1', {
      p_user_id: lifecycleUserId,
    });
    expect(inactiveBeginError?.code).toBe('AD010');

    const { error: authenticatedRecoveryError } = await lifecycleUserClient.rpc(
      'get_account_deletion_customer_recovery_v1',
      { p_user_id: lifecycleUserId },
    );
    expect(authenticatedRecoveryError?.code).toBe('42501');

    expectOwnerSqlFailure(`DELETE FROM private.account_deletion_control WHERE singleton;`, 'AD018');
    expectOwnerSqlFailure(`TRUNCATE private.account_deletion_control;`, 'AD018');

    setGateActivation(true);
  });

  it('replays one bounded lifecycle and checks residual Storage at final delete', async () => {
    setGateActivation(true);

    const firstBegin = await begin(lifecycleUserId);
    const replayedBegin = await begin(lifecycleUserId);
    expect(firstBegin).toEqual({
      billing_state: 'pending',
      calendar_state: 'pending',
      deletion_id: firstBegin.deletion_id,
      storage_state: 'pending',
    });
    expect(replayedBegin).toEqual(firstBegin);

    const { error: storageBeforeCalendarError } = await admin.rpc(
      'claim_account_deletion_step_v1',
      {
        p_deletion_id: firstBegin.deletion_id,
        p_step: 'storage',
        p_user_id: lifecycleUserId,
      },
    );
    expect(storageBeforeCalendarError?.code).toBe('AD013');

    const { error: billingBeforeStorageError } = await admin.rpc('claim_account_deletion_step_v1', {
      p_deletion_id: firstBegin.deletion_id,
      p_step: 'billing',
      p_user_id: lifecycleUserId,
    });
    expect(billingBeforeStorageError?.code).toBe('AD013');
    expect(
      ownerSql(
        `SELECT pg_catalog.string_agg(
  step || ':' || state,
  ','
  ORDER BY step
)
FROM private.account_deletion_steps
WHERE user_id = :'user_id'::UUID;`,
        { user_id: lifecycleUserId },
      ).stdout,
    ).toBe('billing:pending,calendar:pending,storage:pending');

    expectOwnerSqlFailure(`DELETE FROM auth.users WHERE id = :'user_id'::UUID;`, 'AD019', {
      user_id: lifecycleUserId,
    });

    const firstBinding = await bindCalendar(lifecycleUserId, firstBegin.deletion_id);
    const replayedBinding = await bindCalendar(lifecycleUserId, firstBegin.deletion_id);
    expect(firstBinding.calendar_required).toBe(false);
    expect(firstBinding.calendar_deletion_id).not.toBe(firstBegin.deletion_id);
    expect(replayedBinding).toEqual(firstBinding);

    const firstCalendarClaim = await claimStep(lifecycleUserId, firstBegin.deletion_id, 'calendar');
    const firstLeaseId = requireString(firstCalendarClaim.lease_id, 'Initial Calendar lease');
    const liveReplay = await claimStep(lifecycleUserId, firstBegin.deletion_id, 'calendar');
    expect(liveReplay).toEqual(firstCalendarClaim);

    ownerSql(
      `UPDATE private.account_deletion_steps
SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
WHERE user_id = :'user_id'::UUID
  AND deletion_id = :'deletion_id'::UUID
  AND step = 'calendar';`,
      {
        deletion_id: firstBegin.deletion_id,
        user_id: lifecycleUserId,
      },
    );

    const { error: expiredLeaseError } = await admin.rpc('complete_account_deletion_step_v1', {
      p_deletion_id: firstBegin.deletion_id,
      p_lease_id: firstLeaseId,
      p_step: 'calendar',
      p_user_id: lifecycleUserId,
    });
    expect(expiredLeaseError?.code).toBe('AD019');

    const reclaimedCalendar = await claimStep(lifecycleUserId, firstBegin.deletion_id, 'calendar');
    const reclaimedLeaseId = requireString(reclaimedCalendar.lease_id, 'Reclaimed Calendar lease');
    expect(reclaimedLeaseId).not.toBe(firstLeaseId);

    const { error: staleLeaseError } = await admin.rpc('complete_account_deletion_step_v1', {
      p_deletion_id: firstBegin.deletion_id,
      p_lease_id: firstLeaseId,
      p_step: 'calendar',
      p_user_id: lifecycleUserId,
    });
    expect(staleLeaseError?.code).toBe('AD019');

    await completeStep(lifecycleUserId, firstBegin.deletion_id, 'calendar', reclaimedLeaseId);
    const completedCalendarReplay = await claimStep(
      lifecycleUserId,
      firstBegin.deletion_id,
      'calendar',
    );
    expect(completedCalendarReplay.result).toBe('completed');
    expect(completedCalendarReplay.lease_id).toBeNull();
    expect(completedCalendarReplay.lease_expires_at).toBeNull();

    const { error: residualObjectError } = await admin.storage
      .from('attachments')
      .upload(`${lifecycleUserId}/nested/residual.txt`, new TextEncoder().encode('residual'), {
        contentType: 'text/plain',
        upsert: true,
      });
    expect(residualObjectError).toBeNull();

    await completeStorage(lifecycleUserId, firstBegin.deletion_id);
    const billingBinding = await bindBilling(lifecycleUserId, firstBegin.deletion_id);
    expect(billingBinding).toEqual({
      binding_state: 'preparing',
      stripe_customer_id: null,
    });

    const { data: billingSealed, error: billingSealError } = await admin.rpc(
      'seal_billing_account_deletion_v1',
      {
        p_generic_deletion_id: firstBegin.deletion_id,
        p_provider_outcome: 'not_present',
        p_user_id: lifecycleUserId,
      },
    );
    expect(billingSealError).toBeNull();
    expect(billingSealed).toBe(true);

    const { data: billingSealReplay, error: billingSealReplayError } = await admin.rpc(
      'seal_billing_account_deletion_v1',
      {
        p_generic_deletion_id: firstBegin.deletion_id,
        p_provider_outcome: 'not_present',
        p_user_id: lifecycleUserId,
      },
    );
    expect(billingSealReplayError).toBeNull();
    expect(billingSealReplay).toBe(true);

    await completeBilling(lifecycleUserId, firstBegin.deletion_id);
    await sealGeneric(lifecycleUserId, firstBegin.deletion_id);
    await sealGeneric(lifecycleUserId, firstBegin.deletion_id);

    const completedBillingReplay = await claimStep(
      lifecycleUserId,
      firstBegin.deletion_id,
      'billing',
    );
    expect(completedBillingReplay.result).toBe('completed');
    expect(completedBillingReplay.lease_id).toBeNull();

    expectOwnerSqlFailure(`DELETE FROM auth.users WHERE id = :'user_id'::UUID;`, 'AD015', {
      user_id: lifecycleUserId,
    });

    const { error: residualRemoveError } = await admin.storage
      .from('attachments')
      .remove([`${lifecycleUserId}/nested/residual.txt`]);
    expect(residualRemoveError).toBeNull();

    const { error: deleteError } = await admin.auth.admin.deleteUser(lifecycleUserId);
    expect(deleteError).toBeNull();
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
        { user_id: lifecycleUserId },
      ).stdout,
    ).toBe('0');

    const { error: staleWriteError } = await lifecycleUserClient.storage
      .from('attachments')
      .upload(`${lifecycleUserId}/stale.txt`, new TextEncoder().encode('stale'), {
        contentType: 'text/plain',
      });
    expect(staleWriteError).not.toBeNull();
  });

  it('binds billing requests to one provider execution and terminal receipt', async () => {
    setGateActivation(true);

    const customerId = `cus_test_${billingUserId.replaceAll('-', '')}`;
    const deletedSubscriptionId = `sub_deleted_${billingUserId.replaceAll('-', '')}`;
    const replacementSubscriptionId = `sub_current_${billingUserId.replaceAll('-', '')}`;
    const providerObjectId = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const providerResponseUrl = `https://checkout.stripe.com/${providerObjectId}`;
    const operationId = crypto.randomUUID();
    const adoptedOperationId = crypto.randomUUID();

    const { error: profileError } = await admin
      .from('profiles')
      .update({
        stripe_customer_id: customerId,
        subscription_id: deletedSubscriptionId,
        subscription_status: 'active',
      })
      .eq('id', billingUserId);
    expect(profileError).toBeNull();

    const { data: liveDeletedSync, error: liveDeletedSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: deletedSubscriptionId,
      },
    );
    expect(liveDeletedSyncError).toBeNull();
    expect(liveDeletedSync).toBe('updated');
    expect(
      ownerSql(
        `SELECT subscription_status || ':' || COALESCE(subscription_id, 'null')
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
        { user_id: billingUserId },
      ).stdout,
    ).toBe('canceled:null');

    const { data: terminalReplay, error: terminalReplayError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: deletedSubscriptionId,
      },
    );
    expect(terminalReplayError).toBeNull();
    expect(terminalReplay).toBe('already_terminal');

    const { error: replacementProfileError } = await admin
      .from('profiles')
      .update({
        subscription_id: replacementSubscriptionId,
        subscription_status: 'active',
      })
      .eq('id', billingUserId);
    expect(replacementProfileError).toBeNull();

    const { data: staleDeletedSync, error: staleDeletedSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: deletedSubscriptionId,
      },
    );
    expect(staleDeletedSyncError).toBeNull();
    expect(staleDeletedSync).toBe('stale_subscription');
    expect(
      ownerSql(
        `SELECT subscription_status || ':' || subscription_id
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
        { user_id: billingUserId },
      ).stdout,
    ).toBe(`active:${replacementSubscriptionId}`);

    const { data: unknownDeletedSync, error: unknownDeletedSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: 'cus_unknown_terminal',
        p_subscription_id: 'sub_unknown_terminal',
      },
    );
    expect(unknownDeletedSyncError).toBeNull();
    expect(unknownDeletedSync).toBe('unknown_customer');

    const { error: authenticatedDeletedSyncError } = await gateFirstUserClient.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: replacementSubscriptionId,
      },
    );
    expect(authenticatedDeletedSyncError?.code).toBe('42501');
    const { error: authenticatedReceiptCleanupError } = await gateFirstUserClient.rpc(
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      { p_limit: 1 },
    );
    expect(authenticatedReceiptCleanupError?.code).toBe('42501');

    const { data: firstClaimData, error: firstClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: operationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(firstClaimError).toBeNull();
    const firstClaim = firstClaimData?.[0];
    expect(firstClaim).toMatchObject({
      canonical_operation_id: operationId,
      provider_object_id: null,
      provider_response_expires_at: null,
      provider_response_url: null,
      result: 'claimed',
    });
    const firstLeaseId = requireString(firstClaim?.lease_id, 'Billing mutation lease');

    const { data: adoptedClaimData, error: adoptedClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: adoptedOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(adoptedClaimError).toBeNull();
    expect(adoptedClaimData?.[0]).toMatchObject({
      canonical_operation_id: operationId,
      lease_id: firstLeaseId,
      result: 'claimed',
    });

    const { error: reusedOperationError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'checkout',
      p_operation_id: operationId,
      p_request_digest: DIGEST_B,
      p_user_id: billingUserId,
    });
    expect(reusedOperationError?.code).toBe('AD004');

    const { error: wrongCustomerError } = await admin.rpc('start_billing_mutation_v2', {
      p_lease_id: firstLeaseId,
      p_operation_id: operationId,
      p_provider_customer_id: `${customerId}_wrong`,
      p_user_id: billingUserId,
    });
    expect(wrongCustomerError?.code).toBe('AD014');

    const { data: started, error: startError } = await admin.rpc('start_billing_mutation_v2', {
      p_lease_id: firstLeaseId,
      p_operation_id: operationId,
      p_provider_customer_id: customerId,
      p_user_id: billingUserId,
    });
    expect(startError).toBeNull();
    expect(started).toBe('started');

    const { data: startedReplay, error: startReplayError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: firstLeaseId,
        p_operation_id: operationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(startReplayError).toBeNull();
    expect(startedReplay).toBe('reconcile');

    const { data: reconcileClaimData, error: reconcileClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: operationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(reconcileClaimError).toBeNull();
    expect(reconcileClaimData?.[0]).toMatchObject({
      canonical_operation_id: operationId,
      result: 'reconcile',
    });
    expect(reconcileClaimData?.[0]?.lease_id).toBeNull();

    const { data: reconciled, error: reconcileError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: operationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: providerObjectId,
        p_provider_response_url: providerResponseUrl,
        p_user_id: billingUserId,
      },
    );
    expect(reconcileError).toBeNull();
    expect(reconciled).toBe('completed');

    const { data: reconcileReplay, error: reconcileReplayError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: operationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: providerObjectId,
        p_provider_response_url: providerResponseUrl,
        p_user_id: billingUserId,
      },
    );
    expect(reconcileReplayError).toBeNull();
    expect(reconcileReplay).toBe('completed');

    const { data: terminalClaimData, error: terminalClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: operationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(terminalClaimError).toBeNull();
    expect(terminalClaimData?.[0]).toMatchObject({
      canonical_operation_id: operationId,
      lease_id: null,
      provider_object_id: providerObjectId,
      provider_response_url: providerResponseUrl,
      result: 'completed',
    });
    expect(
      Date.parse(
        requireString(terminalClaimData?.[0]?.provider_response_expires_at, 'Response TTL'),
      ),
    ).toBeGreaterThan(Date.now());

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_mutation_claims
SET provider_started_at = timing.now - INTERVAL '31 minutes',
    provider_retry_deadline_at = timing.now - INTERVAL '31 minutes'
      + INTERVAL '23 hours',
    completed_at = timing.now - INTERVAL '30 minutes',
    delete_after = timing.now - INTERVAL '30 minutes'
      + INTERVAL '90 days'
FROM timing
WHERE operation_id = :'operation_id'::UUID;

WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_mutation_responses
SET created_at = timing.now - INTERVAL '30 minutes',
    expires_at = timing.now - INTERVAL '15 minutes'
FROM timing
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: operationId },
    );

    const { data: cleanupData, error: cleanupError } = await admin.rpc(
      'cleanup_billing_mutation_claims_v2',
      { p_limit: 250 },
    );
    expect(cleanupError).toBeNull();
    expect(cleanupData?.[0]).toMatchObject({
      claims_deleted: 0,
      has_more: false,
      provider_responses_redacted: 1,
    });
    const { error: nullCleanupLimitError } = await admin.rpc('cleanup_billing_mutation_claims_v2', {
      p_limit: null as never,
    });
    expect(nullCleanupLimitError?.code).toBe('22023');

    const { data: expiredResponseData, error: expiredResponseError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: operationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(expiredResponseError).toBeNull();
    expect(expiredResponseData?.[0]).toMatchObject({
      canonical_operation_id: operationId,
      provider_object_id: providerObjectId,
      provider_response_expires_at: null,
      provider_response_url: null,
      result: 'response_expired',
    });

    const { data: expiredReconcile, error: expiredReconcileError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: operationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: providerObjectId,
        p_provider_response_url: providerResponseUrl,
        p_user_id: billingUserId,
      },
    );
    expect(expiredReconcileError).toBeNull();
    expect(expiredReconcile).toBe('response_expired');

    const abandonedOperationId = crypto.randomUUID();
    const { data: abandonedClaimData, error: abandonedClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: abandonedOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(abandonedClaimError).toBeNull();
    const abandonedFirstLeaseId = requireString(
      abandonedClaimData?.[0]?.lease_id,
      'Abandoned-path initial lease',
    );

    ownerSql(
      `UPDATE private.billing_mutation_claims
SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: abandonedOperationId },
    );

    const { data: reclaimedBillingData, error: reclaimedBillingError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: abandonedOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(reclaimedBillingError).toBeNull();
    const abandonedReclaimedLeaseId = requireString(
      reclaimedBillingData?.[0]?.lease_id,
      'Abandoned-path reclaimed lease',
    );
    expect(abandonedReclaimedLeaseId).not.toBe(abandonedFirstLeaseId);

    const { data: supersededStart, error: supersededStartError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: abandonedFirstLeaseId,
        p_operation_id: abandonedOperationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(supersededStartError).toBeNull();
    expect(supersededStart).toBe('superseded');

    const { data: abandonedStarted, error: abandonedStartError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: abandonedReclaimedLeaseId,
        p_operation_id: abandonedOperationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(abandonedStartError).toBeNull();
    expect(abandonedStarted).toBe('started');

    const { data: abandoned, error: abandonError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: abandonedOperationId,
        p_outcome: 'not_created',
        p_provider_customer_id: customerId,
        p_provider_object_id: null as never,
        p_provider_response_url: null as never,
        p_user_id: billingUserId,
      },
    );
    expect(abandonError).toBeNull();
    expect(abandoned).toBe('abandoned');

    const { data: abandonedReplayData, error: abandonedReplayError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: abandonedOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(abandonedReplayError).toBeNull();
    expect(abandonedReplayData?.[0]).toMatchObject({
      canonical_operation_id: abandonedOperationId,
      lease_id: null,
      provider_object_id: null,
      result: 'abandoned',
    });

    const { error: changedTerminalOutcomeError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: abandonedOperationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: `bps_test_${crypto.randomUUID().replaceAll('-', '')}`,
        p_provider_response_url: `https://billing.stripe.com/${abandonedOperationId}`,
        p_user_id: billingUserId,
      },
    );
    expect(changedTerminalOutcomeError?.code).toBe('AD004');

    const retryExpiredOperationId = crypto.randomUUID();
    const { data: retryExpiredClaimData, error: retryExpiredClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: retryExpiredOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(retryExpiredClaimError).toBeNull();
    const retryExpiredLeaseId = requireString(
      retryExpiredClaimData?.[0]?.lease_id,
      'Retry deadline lease',
    );
    const { data: retryExpiredStarted, error: retryExpiredStartError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: retryExpiredLeaseId,
        p_operation_id: retryExpiredOperationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(retryExpiredStartError).toBeNull();
    expect(retryExpiredStarted).toBe('started');

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_mutation_claims
SET provider_started_at = timing.now - INTERVAL '24 hours',
    provider_retry_deadline_at = timing.now - INTERVAL '1 hour'
FROM timing
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: retryExpiredOperationId },
    );

    const { data: retryExpiredData, error: retryExpiredError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: retryExpiredOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(retryExpiredError).toBeNull();
    expect(retryExpiredData?.[0]).toMatchObject({
      canonical_operation_id: retryExpiredOperationId,
      provider_response_expires_at: null,
      provider_response_url: null,
      result: 'abandoned',
    });
    expect(
      ownerSql(
        `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: retryExpiredOperationId },
      ).stdout,
    ).toBe('abandoned:provider_retry_expired');

    const closingReplayOperationId = crypto.randomUUID();
    const closingReplayUrl = `https://billing.stripe.com/${closingReplayOperationId}`;
    const { data: closingReplayClaimData, error: closingReplayClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: closingReplayOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(closingReplayClaimError).toBeNull();
    const closingReplayLeaseId = requireString(
      closingReplayClaimData?.[0]?.lease_id,
      'Closing replay lease',
    );

    const { data: closingReplayStarted, error: closingReplayStartError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: closingReplayLeaseId,
        p_operation_id: closingReplayOperationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(closingReplayStartError).toBeNull();
    expect(closingReplayStarted).toBe('started');

    const { data: closingReplayReconciled, error: closingReplayReconcileError } = await admin.rpc(
      'reconcile_billing_mutation_v4',
      {
        p_operation_id: closingReplayOperationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: `bps_test_${closingReplayOperationId.replaceAll('-', '')}`,
        p_provider_response_url: closingReplayUrl,
        p_user_id: billingUserId,
      },
    );
    expect(closingReplayReconcileError).toBeNull();
    expect(closingReplayReconciled).toBe('completed');

    const closingInFlightOperationId = crypto.randomUUID();
    const { data: closingInFlightClaimData, error: closingInFlightClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: closingInFlightOperationId,
        p_request_digest: DIGEST_B,
        p_user_id: billingUserId,
      },
    );
    expect(closingInFlightClaimError).toBeNull();
    const closingInFlightLeaseId = requireString(
      closingInFlightClaimData?.[0]?.lease_id,
      'Closing in-flight lease',
    );
    const { data: closingInFlightStarted, error: closingInFlightStartError } = await admin.rpc(
      'start_billing_mutation_v2',
      {
        p_lease_id: closingInFlightLeaseId,
        p_operation_id: closingInFlightOperationId,
        p_provider_customer_id: customerId,
        p_user_id: billingUserId,
      },
    );
    expect(closingInFlightStartError).toBeNull();
    expect(closingInFlightStarted).toBe('started');

    const { error: liveProviderBeginError } = await admin.rpc('begin_account_deletion_v1', {
      p_user_id: billingUserId,
    });
    expect(liveProviderBeginError?.code).toBe('AD019');

    expect(
      ownerSql(
        `SELECT state || ':' || COALESCE(terminal_reason, '')
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: closingInFlightOperationId },
      ).stdout,
    ).toBe('provider_started:');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
        { user_id: billingUserId },
      ).stdout,
    ).toBe('0');

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_mutation_claims
SET provider_started_at = timing.now - INTERVAL '24 hours',
    provider_retry_deadline_at = timing.now - INTERVAL '1 hour'
FROM timing
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: closingInFlightOperationId },
    );

    const deletion = await begin(billingUserId);

    expect(
      ownerSql(
        `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: closingInFlightOperationId },
      ).stdout,
    ).toBe('abandoned:account_deletion_after_provider_start');

    const { data: closingInFlightReconciled, error: closingInFlightReconcileError } =
      await admin.rpc('reconcile_billing_mutation_v4', {
        p_operation_id: closingInFlightOperationId,
        p_outcome: 'completed',
        p_provider_customer_id: customerId,
        p_provider_object_id: `cs_test_${closingInFlightOperationId.replaceAll('-', '')}`,
        p_provider_response_url: `https://checkout.stripe.com/${closingInFlightOperationId}`,
        p_user_id: billingUserId,
      });
    expect(closingInFlightReconcileError).toBeNull();
    expect(closingInFlightReconciled).toBe('account_closing');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_mutation_responses
WHERE operation_id IN (
  :'terminal_operation_id'::UUID,
  :'in_flight_operation_id'::UUID
);`,
        {
          in_flight_operation_id: closingInFlightOperationId,
          terminal_operation_id: closingReplayOperationId,
        },
      ).stdout,
    ).toBe('0');

    const { data: closingReplayData, error: closingReplayError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'portal',
        p_operation_id: closingReplayOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: billingUserId,
      },
    );
    expect(closingReplayError).toBeNull();
    expect(closingReplayData?.[0]).toMatchObject({
      canonical_operation_id: closingReplayOperationId,
      provider_response_expires_at: null,
      provider_response_url: null,
      result: 'account_closing',
    });

    const { error: postGateClaimError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'portal',
      p_operation_id: crypto.randomUUID(),
      p_request_digest: DIGEST_B,
      p_user_id: billingUserId,
    });
    expect(postGateClaimError?.code).toBe('AD019');

    await completeNoSourceCalendar(billingUserId, deletion.deletion_id);
    await completeStorage(billingUserId, deletion.deletion_id);

    const billingBinding = await bindBilling(billingUserId, deletion.deletion_id);
    expect(billingBinding).toEqual({
      binding_state: 'preparing',
      stripe_customer_id: customerId,
    });

    const { data: providerSealed, error: providerSealError } = await admin.rpc(
      'seal_billing_account_deletion_v1',
      {
        p_generic_deletion_id: deletion.deletion_id,
        p_provider_outcome: 'deleted',
        p_user_id: billingUserId,
      },
    );
    expect(providerSealError).toBeNull();
    expect(providerSealed).toBe(true);

    await completeBilling(billingUserId, deletion.deletion_id);
    await sealGeneric(billingUserId, deletion.deletion_id);

    const { data: deletingAccountSync, error: deletingAccountSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: replacementSubscriptionId,
      },
    );
    expect(deletingAccountSyncError).toBeNull();
    expect(deletingAccountSync).toBe('account_deleting');
    expect(
      ownerSql(
        `SELECT subscription_status || ':' || COALESCE(subscription_id, 'null')
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
        { user_id: billingUserId },
      ).stdout,
    ).toBe('canceled:null');

    const terminalRollbackObject = `${billingUserId}/terminal-rollback.txt`;
    const { error: terminalRollbackUploadError } = await admin.storage
      .from('attachments')
      .upload(terminalRollbackObject, new TextEncoder().encode('rollback'), {
        contentType: 'text/plain',
        upsert: true,
      });
    expect(terminalRollbackUploadError).toBeNull();

    expectOwnerSqlFailure(`DELETE FROM auth.users WHERE id = :'user_id'::UUID;`, 'AD015', {
      user_id: billingUserId,
    });
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
);`,
        { customer_id: customerId },
      ).stdout,
    ).toBe('0');

    const { error: terminalRollbackRemoveError } = await admin.storage
      .from('attachments')
      .remove([terminalRollbackObject]);
    expect(terminalRollbackRemoveError).toBeNull();

    const explicitRollback = ownerSql(
      `BEGIN;
DELETE FROM auth.users
WHERE id = :'user_id'::UUID;
SELECT pg_catalog.count(*)::TEXT
FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
);
ROLLBACK;`,
      {
        customer_id: customerId,
        user_id: billingUserId,
      },
    );
    expect(explicitRollback.stdout).toBe('1');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM auth.users
WHERE id = :'user_id'::UUID;`,
        { user_id: billingUserId },
      ).stdout,
    ).toBe('1');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
);`,
        { customer_id: customerId },
      ).stdout,
    ).toBe('0');

    const { error: deleteError } = await admin.auth.admin.deleteUser(billingUserId);
    expect(deleteError).toBeNull();

    const { data: deletedAccountSync, error: deletedAccountSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: replacementSubscriptionId,
      },
    );
    expect(deletedAccountSyncError).toBeNull();
    expect(deletedAccountSync).toBe('account_deleted');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
);`,
        { customer_id: customerId },
      ).stdout,
    ).toBe('1');

    const { data: freshCleanup, error: freshCleanupError } = await admin.rpc(
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      { p_limit: 1 },
    );
    expect(freshCleanupError).toBeNull();
    expect(freshCleanup?.[0]).toEqual({
      deleted_count: 0,
      has_more: false,
    });

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_account_deletion_terminal_receipts
SET recorded_at = timing.now - INTERVAL '31 days',
    expires_at = timing.now - INTERVAL '1 day'
FROM timing
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
);`,
      { customer_id: customerId },
    );

    const additionalExpiredCustomerId = `cus_expired_${crypto.randomUUID().replaceAll('-', '')}`;
    ownerSql(
      `INSERT INTO private.billing_account_deletion_terminal_receipts (
  stripe_customer_id_digest,
  recorded_at,
  expires_at
) VALUES (
  pg_catalog.sha256(pg_catalog.convert_to(:'customer_id', 'UTF8')),
  pg_catalog.clock_timestamp() - INTERVAL '2 days',
  pg_catalog.clock_timestamp() - INTERVAL '1 day'
);`,
      { customer_id: additionalExpiredCustomerId },
    );

    const { data: expiredCleanup, error: expiredCleanupError } = await admin.rpc(
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      { p_limit: 1 },
    );
    expect(expiredCleanupError).toBeNull();
    expect(expiredCleanup?.[0]).toEqual({
      deleted_count: 1,
      has_more: true,
    });

    const { data: finalCleanup, error: finalCleanupError } = await admin.rpc(
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      { p_limit: 1 },
    );
    expect(finalCleanupError).toBeNull();
    expect(finalCleanup?.[0]).toEqual({
      deleted_count: 1,
      has_more: false,
    });

    const { data: afterRetentionSync, error: afterRetentionSyncError } = await admin.rpc(
      'sync_billing_subscription_deleted_v1',
      {
        p_stripe_customer_id: customerId,
        p_subscription_id: replacementSubscriptionId,
      },
    );
    expect(afterRetentionSyncError).toBeNull();
    expect(afterRetentionSync).toBe('unknown_customer');
  });

  it('fences lazy Stripe Customer creation and recovers its bounded unknown response', async () => {
    setGateActivation(true);

    const completedOperationId = crypto.randomUUID();
    const completedCustomerId = `cus_test_${customerProvisioningUserId.replaceAll('-', '')}`;
    const { data: completedMutationData, error: completedMutationError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: completedOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(completedMutationError).toBeNull();
    expect(completedMutationData?.[0]?.result).toBe('claimed');

    const { data: customerClaimData, error: customerClaimError } = await admin.rpc(
      'claim_billing_customer_provisioning_v2',
      {
        p_email_digest: CUSTOMER_EMAIL_DIGEST,
        p_operation_id: completedOperationId,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(customerClaimError).toBeNull();
    expect(customerClaimData?.[0]).toMatchObject({
      provider_customer_id: null,
      result: 'claimed',
    });
    const customerLeaseId = requireString(
      customerClaimData?.[0]?.lease_id,
      'Customer provisioning lease',
    );

    const { error: completionBeforeStartError } = await admin.rpc(
      'complete_billing_customer_provisioning_v2',
      {
        p_operation_id: completedOperationId,
        p_provider_customer_id: completedCustomerId,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(completionBeforeStartError?.code).toBe('AD019');
    expect(
      ownerSql(
        `SELECT stripe_customer_id IS NULL
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
        { user_id: customerProvisioningUserId },
      ).stdout,
    ).toBe('t');

    const { data: customerStarted, error: customerStartError } = await admin.rpc(
      'start_billing_customer_provisioning_v2',
      {
        p_lease_id: customerLeaseId,
        p_operation_id: completedOperationId,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(customerStartError).toBeNull();
    expect(customerStarted).toBe('started');

    const { data: liveRecovery, error: liveRecoveryError } = await admin.rpc(
      'get_account_deletion_customer_recovery_v1',
      { p_user_id: customerProvisioningUserId },
    );
    expect(liveRecoveryError).toBeNull();
    expect(liveRecovery?.[0]).toMatchObject({
      operation_id: completedOperationId,
      result: 'wait',
    });

    const { error: liveProvisioningDeletionError } = await admin.rpc('begin_account_deletion_v1', {
      p_user_id: customerProvisioningUserId,
    });
    expect(liveProvisioningDeletionError?.code).toBe('AD019');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
        { user_id: customerProvisioningUserId },
      ).stdout,
    ).toBe('0');

    const { data: customerCompleted, error: customerCompletionError } = await admin.rpc(
      'complete_billing_customer_provisioning_v2',
      {
        p_operation_id: completedOperationId,
        p_provider_customer_id: completedCustomerId,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(customerCompletionError).toBeNull();
    expect(customerCompleted).toBe(completedCustomerId);

    const { data: customerCompletionReplay, error: customerCompletionReplayError } =
      await admin.rpc('complete_billing_customer_provisioning_v2', {
        p_operation_id: completedOperationId,
        p_provider_customer_id: completedCustomerId,
        p_user_id: customerProvisioningUserId,
      });
    expect(customerCompletionReplayError).toBeNull();
    expect(customerCompletionReplay).toBe(completedCustomerId);

    const { error: unrelatedCompletionReplayError } = await admin.rpc(
      'complete_billing_customer_provisioning_v2',
      {
        p_operation_id: crypto.randomUUID(),
        p_provider_customer_id: completedCustomerId,
        p_user_id: customerProvisioningUserId,
      },
    );
    expect(unrelatedCompletionReplayError?.code).toBe('AD012');

    await begin(customerProvisioningUserId);
    expect(
      ownerSql(
        `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: completedOperationId },
      ).stdout,
    ).toBe('abandoned:account_deletion_before_provider_start');
    expect(
      ownerSql(
        `SELECT stripe_customer_id
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
        { user_id: customerProvisioningUserId },
      ).stdout,
    ).toBe(completedCustomerId);

    const recoveryOperationId = crypto.randomUUID();
    const { error: recoveryMutationError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'checkout',
      p_operation_id: recoveryOperationId,
      p_request_digest: DIGEST_B,
      p_user_id: customerRecoveryUserId,
    });
    expect(recoveryMutationError).toBeNull();
    const { data: recoveryClaimData, error: recoveryClaimError } = await admin.rpc(
      'claim_billing_customer_provisioning_v2',
      {
        p_email_digest: CUSTOMER_EMAIL_DIGEST,
        p_operation_id: recoveryOperationId,
        p_user_id: customerRecoveryUserId,
      },
    );
    expect(recoveryClaimError).toBeNull();
    const recoveryLeaseId = requireString(
      recoveryClaimData?.[0]?.lease_id,
      'Customer recovery lease',
    );
    const { data: recoveryStarted, error: recoveryStartError } = await admin.rpc(
      'start_billing_customer_provisioning_v2',
      {
        p_lease_id: recoveryLeaseId,
        p_operation_id: recoveryOperationId,
        p_user_id: customerRecoveryUserId,
      },
    );
    expect(recoveryStartError).toBeNull();
    expect(recoveryStarted).toBe('started');

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_customer_provisioning_attempts
SET provider_started_at = timing.now - INTERVAL '24 hours',
    provider_retry_deadline_at = timing.now - INTERVAL '1 hour'
FROM timing
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: recoveryOperationId },
    );

    const { data: recoveryReplayData, error: recoveryReplayError } = await admin.rpc(
      'claim_billing_customer_provisioning_v2',
      {
        p_email_digest: CUSTOMER_EMAIL_DIGEST,
        p_operation_id: recoveryOperationId,
        p_user_id: customerRecoveryUserId,
      },
    );
    expect(recoveryReplayError).toBeNull();
    expect(recoveryReplayData?.[0]).toMatchObject({
      lease_expires_at: null,
      lease_id: null,
      provider_customer_id: null,
      result: 'recover',
    });

    const { data: expiredRecovery, error: expiredRecoveryError } = await admin.rpc(
      'get_account_deletion_customer_recovery_v1',
      { p_user_id: customerRecoveryUserId },
    );
    expect(expiredRecoveryError).toBeNull();
    expect(expiredRecovery?.[0]).toMatchObject({
      operation_id: recoveryOperationId,
      result: 'recover',
    });

    const { error: unreconciledDeletionError } = await admin.rpc('begin_account_deletion_v1', {
      p_user_id: customerRecoveryUserId,
    });
    expect(unreconciledDeletionError?.code).toBe('AD019');

    const recoveredCustomerId = `cus_recovered_${customerRecoveryUserId.replaceAll('-', '')}`;
    const { data: recoveredCustomer, error: recoveredCustomerError } = await admin.rpc(
      'complete_billing_customer_provisioning_v2',
      {
        p_operation_id: recoveryOperationId,
        p_provider_customer_id: recoveredCustomerId,
        p_user_id: customerRecoveryUserId,
      },
    );
    expect(recoveredCustomerError).toBeNull();
    expect(recoveredCustomer).toBe(recoveredCustomerId);

    const { data: completedRecovery, error: completedRecoveryError } = await admin.rpc(
      'get_account_deletion_customer_recovery_v1',
      { p_user_id: customerRecoveryUserId },
    );
    expect(completedRecoveryError).toBeNull();
    expect(completedRecovery?.[0]).toEqual({
      operation_id: null,
      provider_retry_deadline_at: null,
      result: 'none',
    });

    await begin(customerRecoveryUserId);
    expect(
      ownerSql(
        `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: recoveryOperationId },
      ).stdout,
    ).toBe('abandoned:account_deletion_before_provider_start');
    expect(
      ownerSql(
        `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_customer_provisioning_attempts
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: recoveryOperationId },
      ).stdout,
    ).toBe('0');
  });

  it('terminalizes an exhausted Customer recovery before allowing a fresh top-level intent', async () => {
    setGateActivation(true);

    const exhaustedOperationId = crypto.randomUUID();
    const { error: mutationClaimError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'checkout',
      p_operation_id: exhaustedOperationId,
      p_request_digest: DIGEST_A,
      p_user_id: customerAbandonUserId,
    });
    expect(mutationClaimError).toBeNull();

    const { data: provisioningClaim, error: provisioningClaimError } = await admin.rpc(
      'claim_billing_customer_provisioning_v2',
      {
        p_email_digest: CUSTOMER_EMAIL_DIGEST,
        p_operation_id: exhaustedOperationId,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(provisioningClaimError).toBeNull();
    const leaseId = requireString(
      provisioningClaim?.[0]?.lease_id,
      'Exhausted Customer provisioning lease',
    );

    const { data: started, error: startError } = await admin.rpc(
      'start_billing_customer_provisioning_v2',
      {
        p_lease_id: leaseId,
        p_operation_id: exhaustedOperationId,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(startError).toBeNull();
    expect(started).toBe('started');

    ownerSql(
      `WITH timing AS (
  SELECT pg_catalog.clock_timestamp() AS now
)
UPDATE private.billing_customer_provisioning_attempts
SET provider_started_at = timing.now - INTERVAL '24 hours',
    provider_retry_deadline_at = timing.now - INTERVAL '1 hour'
FROM timing
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: exhaustedOperationId },
    );

    const { data: abandoned, error: abandonError } = await admin.rpc(
      'abandon_billing_customer_provisioning_v2',
      {
        p_operation_id: exhaustedOperationId,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(abandonError).toBeNull();
    expect(abandoned).toBe(true);

    const { data: abandonReplay, error: abandonReplayError } = await admin.rpc(
      'abandon_billing_customer_provisioning_v2',
      {
        p_operation_id: exhaustedOperationId,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(abandonReplayError).toBeNull();
    expect(abandonReplay).toBe(true);
    expect(
      ownerSql(
        `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: exhaustedOperationId },
      ).stdout,
    ).toBe('abandoned:customer_provisioning_not_recovered');

    const { data: sameOperationReplay, error: sameOperationReplayError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: exhaustedOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(sameOperationReplayError).toBeNull();
    expect(sameOperationReplay?.[0]?.result).toBe('abandoned');

    const { error: reopenedProvisioningError } = await admin.rpc(
      'claim_billing_customer_provisioning_v2',
      {
        p_email_digest: CUSTOMER_EMAIL_DIGEST,
        p_operation_id: exhaustedOperationId,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(reopenedProvisioningError?.code).toBe('AD019');

    const freshOperationId = crypto.randomUUID();
    const { data: freshClaim, error: freshClaimError } = await admin.rpc(
      'claim_billing_mutation_v3',
      {
        p_mutation_kind: 'checkout',
        p_operation_id: freshOperationId,
        p_request_digest: DIGEST_A,
        p_user_id: customerAbandonUserId,
      },
    );
    expect(freshClaimError).toBeNull();
    expect(freshClaim?.[0]).toMatchObject({
      canonical_operation_id: freshOperationId,
      result: 'claimed',
    });

    await begin(customerAbandonUserId);
  });

  it('blocks new Calendar, billing, and Storage writes once closing starts', async () => {
    setGateActivation(true);

    // avatars の key は `<uid>/avatar.<ext>` しか許されない（#2460）。任意名を使うと
    // 削除ゲートではなく key 形式の policy で弾かれ、ゲートが外れても緑になる偽陽性になる。
    const { error: beforeGateAvatarError } = await gateFirstUserClient.storage
      .from('avatars')
      .upload(`${gateFirstUserId}/avatar.png`, new Uint8Array([137, 80, 78, 71]), {
        contentType: 'image/png',
        upsert: true,
      });
    const { error: beforeGateAttachmentError } = await gateFirstUserClient.storage
      .from('attachments')
      .upload(`${gateFirstUserId}/before.txt`, new TextEncoder().encode('before'), {
        contentType: 'text/plain',
        upsert: true,
      });
    expect(beforeGateAvatarError).toBeNull();
    expect(beforeGateAttachmentError).toBeNull();

    const [{ error: avatarCleanupError }, { error: attachmentCleanupError }] = await Promise.all([
      admin.storage.from('avatars').remove([`${gateFirstUserId}/avatar.png`]),
      admin.storage.from('attachments').remove([`${gateFirstUserId}/before.txt`]),
    ]);
    expect(avatarCleanupError).toBeNull();
    expect(attachmentCleanupError).toBeNull();

    const gateFirstOperation = await begin(gateFirstUserId);

    const { error: gateFirstBillingError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'checkout',
      p_operation_id: crypto.randomUUID(),
      p_request_digest: DIGEST_A,
      p_user_id: gateFirstUserId,
    });
    expect(gateFirstBillingError?.code).toBe('AD019');

    // ここも許可された key 形式を使う。ゲートだけが拒否理由になるようにする。
    const { error: gatedAvatarError } = await gateFirstUserClient.storage
      .from('avatars')
      .upload(`${gateFirstUserId}/avatar.webp`, new Uint8Array([137, 80, 78, 71]), {
        contentType: 'image/png',
      });
    const { error: gatedAttachmentError } = await gateFirstUserClient.storage
      .from('attachments')
      .upload(`${gateFirstUserId}/after.txt`, new TextEncoder().encode('after'), {
        contentType: 'text/plain',
      });
    expect(gatedAvatarError).not.toBeNull();
    expect(gatedAttachmentError).not.toBeNull();

    expectOwnerSqlFailure(
      `SELECT private.assert_calendar_account_not_deleting_v1(
  :'user_id'::UUID
);`,
      'CA019',
      { user_id: gateFirstUserId },
    );
    expect(gateFirstOperation.deletion_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });
});
