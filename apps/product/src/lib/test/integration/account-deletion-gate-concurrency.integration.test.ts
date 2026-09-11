import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const TEST_PASSWORD = 'account-gate-race-password';
const REQUEST_DIGEST = 'c'.repeat(64);
const CUSTOMER_EMAIL_DIGEST = 'd'.repeat(64);
const STORAGE_OBJECT_NAME = 'storage-first.txt';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const storageFirstUserId = crypto.randomUUID();
const storageGateFirstUserId = crypto.randomUUID();
const billingFirstUserId = crypto.randomUUID();
const billingGateFirstUserId = crypto.randomUUID();
const billingProviderStartFirstUserId = crypto.randomUUID();
const customerStartFirstUserId = crypto.randomUUID();
const customerGateFirstUserId = crypto.randomUUID();
const customerRecoveryFirstUserId = crypto.randomUUID();
const planWriterFirstUserId = crypto.randomUUID();
const planGateFirstUserId = crypto.randomUUID();
const recordGateFirstUserId = crypto.randomUUID();
const webhookFirstUserId = crypto.randomUUID();
const deletionFirstUserId = crypto.randomUUID();
const userIds = [
  storageFirstUserId,
  storageGateFirstUserId,
  billingFirstUserId,
  billingGateFirstUserId,
  billingProviderStartFirstUserId,
  customerStartFirstUserId,
  customerGateFirstUserId,
  customerRecoveryFirstUserId,
  planWriterFirstUserId,
  planGateFirstUserId,
  recordGateFirstUserId,
  webhookFirstUserId,
  deletionFirstUserId,
];

interface SqlResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

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

function psqlEnv(applicationName?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: 'postgres',
    ...(applicationName ? { PGAPPNAME: applicationName } : {}),
  };
}

function ownerSql(sql: string, variables: Record<string, string> = {}): string {
  const result = spawnSync('psql', psqlArgs(variables), {
    encoding: 'utf8',
    env: psqlEnv(),
    input: sql,
  });

  if (result.status !== 0) {
    throw new Error(`Account deletion race SQL failed: ${result.stderr}`);
  }

  return result.stdout.trim();
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

function serviceRoleTransaction(sql: string): string {
  return `BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
${sql}
COMMIT;`;
}

function authenticatedStorageInsert(): string {
  return `BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.json_build_object(
    'role',
    'authenticated',
    'sub',
    :'user_id'
  )::TEXT,
  true
);
INSERT INTO storage.objects (
  bucket_id,
  name,
  owner,
  owner_id,
  metadata
) VALUES (
  'attachments',
  :'user_id' || '/' || :'object_name',
  :'user_id'::UUID,
  :'user_id',
  '{}'::JSONB
);
COMMIT;`;
}

function directTimeblockInsert(table: 'plans' | 'records'): string {
  return `BEGIN;
INSERT INTO public.${table} (
  id,
  user_id,
  title,
  start_at,
  end_at,
  source
) VALUES (
  :'timeblock_id'::UUID,
  :'user_id'::UUID,
  :'title',
  :'start_at'::TIMESTAMPTZ,
  :'end_at'::TIMESTAMPTZ,
  'manual'
);
COMMIT;`;
}

async function runSqlAsync(
  sql: string,
  variables: Record<string, string>,
  applicationName: string,
): Promise<SqlResult> {
  const process = spawn('psql', psqlArgs(variables), {
    env: psqlEnv(applicationName),
  });
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  process.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
  const [code] = (await once(process, 'close')) as [number | null];
  return { code, stderr, stdout: stdout.trim() };
}

async function holdTransaction(
  sql: string,
  variables: Record<string, string>,
  applicationName: string,
): Promise<{ release: (commit?: boolean) => Promise<SqlResult> }> {
  const process = spawn('psql', psqlArgs(variables), {
    env: psqlEnv(applicationName),
  });
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  process.stdin.write(`\\set VERBOSITY verbose\n${sql}\nSELECT 'LOCKED';\n`);

  const deadline = Date.now() + 5_000;
  while (!stdout.includes('LOCKED')) {
    if (process.exitCode !== null) {
      throw new Error(`Transaction holder exited before its barrier: ${stderr}`);
    }
    if (Date.now() >= deadline) {
      process.stdin.end('ROLLBACK;\n');
      throw new Error(`Timed out waiting for transaction holder: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  let releaseResult: Promise<SqlResult> | null = null;
  return {
    release: async (commit = true) => {
      if (!releaseResult) {
        process.stdin.end(commit ? 'COMMIT;\n' : 'ROLLBACK;\n');
        releaseResult = (async () => {
          const [code] = (await once(process, 'close')) as [number | null];
          return { code, stderr, stdout: stdout.trim() };
        })();
      }
      return releaseResult;
    },
  };
}

async function waitForApplicationLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = ownerSql(
      `SELECT pg_catalog.count(*)::TEXT
FROM pg_catalog.pg_stat_activity AS activity
WHERE activity.application_name = :'application_name'
  AND activity.wait_event_type = 'Lock';`,
      { application_name: applicationName },
    );
    if (Number(waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a lock`);
}

function cleanupUserState(userId: string): void {
  ownerSql(
    `DELETE FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.billing_mutation_claims
WHERE user_id = :'user_id'::UUID;`,
    { user_id: userId },
  );
}

async function prepareCustomerProvisioning(
  userId: string,
): Promise<{ leaseId: string; operationId: string }> {
  const operationId = crypto.randomUUID();
  const { error: mutationError } = await admin.rpc('claim_billing_mutation_v3', {
    p_mutation_kind: 'checkout',
    p_operation_id: operationId,
    p_request_digest: REQUEST_DIGEST,
    p_user_id: userId,
  });
  if (mutationError) throw mutationError;

  const { data, error } = await admin.rpc('claim_billing_customer_provisioning_v2', {
    p_email_digest: CUSTOMER_EMAIL_DIGEST,
    p_operation_id: operationId,
    p_user_id: userId,
  });
  if (error) throw error;

  const leaseId = data?.[0]?.lease_id;
  if (typeof leaseId !== 'string' || leaseId.length === 0) {
    throw new Error('Customer provisioning lease was not returned');
  }

  return { leaseId, operationId };
}

function requireRpcValue(value: null | string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} was not returned`);
  }
  return value;
}

async function prepareReadyBillingAccountDeletion(
  userId: string,
): Promise<{ customerId: string; subscriptionId: string }> {
  const customerId = `cus_race_${userId.replaceAll('-', '')}`;
  const subscriptionId = `sub_race_${userId.replaceAll('-', '')}`;
  const { error: profileError } = await admin
    .from('profiles')
    .update({
      stripe_customer_id: customerId,
      subscription_id: subscriptionId,
      subscription_status: 'active',
    })
    .eq('id', userId);
  if (profileError) throw profileError;

  const { data: beginData, error: beginError } = await admin.rpc('begin_account_deletion_v1', {
    p_user_id: userId,
  });
  if (beginError) throw beginError;
  const deletionId = requireRpcValue(beginData?.[0]?.deletion_id, 'Account deletion id');

  const { error: calendarBindingError } = await admin.rpc('bind_calendar_account_deletion_v1', {
    p_generic_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (calendarBindingError) throw calendarBindingError;

  for (const step of ['calendar', 'storage'] as const) {
    const { data: claimData, error: claimError } = await admin.rpc(
      'claim_account_deletion_step_v1',
      {
        p_deletion_id: deletionId,
        p_step: step,
        p_user_id: userId,
      },
    );
    if (claimError) throw claimError;
    const leaseId = requireRpcValue(claimData?.[0]?.lease_id, `${step} lease`);
    const { error: completeError } = await admin.rpc('complete_account_deletion_step_v1', {
      p_deletion_id: deletionId,
      p_lease_id: leaseId,
      p_step: step,
      p_user_id: userId,
    });
    if (completeError) throw completeError;
  }

  const { error: billingBindingError } = await admin.rpc('bind_billing_account_deletion_v1', {
    p_generic_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (billingBindingError) throw billingBindingError;
  const { error: billingSealError } = await admin.rpc('seal_billing_account_deletion_v1', {
    p_generic_deletion_id: deletionId,
    p_provider_outcome: 'deleted',
    p_user_id: userId,
  });
  if (billingSealError) throw billingSealError;

  const { data: billingClaim, error: billingClaimError } = await admin.rpc(
    'claim_account_deletion_step_v1',
    {
      p_deletion_id: deletionId,
      p_step: 'billing',
      p_user_id: userId,
    },
  );
  if (billingClaimError) throw billingClaimError;
  const billingLeaseId = requireRpcValue(billingClaim?.[0]?.lease_id, 'billing lease');
  const { error: billingCompleteError } = await admin.rpc('complete_account_deletion_step_v1', {
    p_deletion_id: deletionId,
    p_lease_id: billingLeaseId,
    p_step: 'billing',
    p_user_id: userId,
  });
  if (billingCompleteError) throw billingCompleteError;

  const { error: genericSealError } = await admin.rpc('seal_account_deletion_v1', {
    p_deletion_id: deletionId,
    p_user_id: userId,
  });
  if (genericSealError) throw genericSealError;

  return { customerId, subscriptionId };
}

describe.skipIf(!RUN_LOCAL)('account deletion source-writer races', () => {
  beforeAll(async () => {
    setGateActivation(true);
    for (const userId of userIds) {
      const { error } = await admin.auth.admin.createUser({
        id: userId,
        email: `account-gate-race-${userId}@example.com`,
        password: TEST_PASSWORD,
        email_confirm: true,
      });
      if (error) throw error;
    }
  });

  afterAll(async () => {
    setGateActivation(false);
    ownerSql(
      `BEGIN;
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects
WHERE bucket_id = 'attachments'
  AND name = :'user_id' || '/' || :'object_name';
COMMIT;`,
      {
        object_name: STORAGE_OBJECT_NAME,
        user_id: storageFirstUserId,
      },
    );

    for (const userId of userIds) {
      cleanupUserState(userId);
      await admin.auth.admin.deleteUser(userId);
    }

    ownerSql(
      `DELETE FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest IN (
  pg_catalog.sha256(pg_catalog.convert_to(:'webhook_customer_id', 'UTF8')),
  pg_catalog.sha256(pg_catalog.convert_to(:'deletion_customer_id', 'UTF8'))
);`,
      {
        deletion_customer_id: `cus_race_${deletionFirstUserId.replaceAll('-', '')}`,
        webhook_customer_id: `cus_race_${webhookFirstUserId.replaceAll('-', '')}`,
      },
    );
  });

  it('commits an authenticated Storage write that acquired the fence before begin', async () => {
    const holder = await holdTransaction(
      authenticatedStorageInsert().replace('COMMIT;', ''),
      {
        object_name: STORAGE_OBJECT_NAME,
        user_id: storageFirstUserId,
      },
      'account-gate-storage-first-holder',
    );
    const waiterName = 'account-gate-storage-first-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: storageFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM storage.objects
WHERE bucket_id = 'attachments'
  AND name = :'user_id' || '/' || :'object_name';`,
          {
            object_name: STORAGE_OBJECT_NAME,
            user_id: storageFirstUserId,
          },
        ),
      ).toBe('1');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
          { user_id: storageFirstUserId },
        ),
      ).toBe('1');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('rejects an authenticated Storage write that waits behind begin', async () => {
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ).replace('COMMIT;', ''),
      { user_id: storageGateFirstUserId },
      'account-gate-storage-gate-holder',
    );
    const waiterName = 'account-gate-storage-gate-writer';
    const writeAttempt = runSqlAsync(
      authenticatedStorageInsert(),
      {
        object_name: 'gate-first.txt',
        user_id: storageGateFirstUserId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const writeResult = await writeAttempt;
      expect(writeResult.code).not.toBe(0);
      expect(writeResult.stderr).toContain('42501');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM storage.objects
WHERE bucket_id = 'attachments'
  AND name = :'user_id' || '/gate-first.txt';`,
          { user_id: storageGateFirstUserId },
        ),
      ).toBe('0');
    } finally {
      await holder.release(false);
      await writeAttempt;
    }
  });

  it('terminalizes a pre-provider billing claim that finishes before begin', async () => {
    const billingOperationId = crypto.randomUUID();
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.claim_billing_mutation_v3(
  'checkout',
  :'operation_id'::UUID,
  :'request_digest',
  :'user_id'::UUID
);`,
      ).replace('COMMIT;', ''),
      {
        operation_id: billingOperationId,
        request_digest: REQUEST_DIGEST,
        user_id: billingFirstUserId,
      },
      'account-gate-billing-first-holder',
    );
    const waiterName = 'account-gate-billing-first-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: billingFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).toBe(0);
      const deletionId = ownerSql(
        `SELECT deletion_id::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
        { user_id: billingFirstUserId },
      );

      const { data: bindingData, error: bindingError } = await admin.rpc(
        'bind_billing_account_deletion_v1',
        {
          p_generic_deletion_id: deletionId,
          p_user_id: billingFirstUserId,
        },
      );
      expect(bindingError).toBeNull();
      expect(bindingData?.[0]).toEqual({
        binding_state: 'preparing',
        stripe_customer_id: null,
      });
      expect(
        ownerSql(
          `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: billingOperationId },
        ),
      ).toBe('abandoned:account_deletion_before_provider_start');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('rejects a billing claim that waits behind begin', async () => {
    const billingOperationId = crypto.randomUUID();
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ).replace('COMMIT;', ''),
      { user_id: billingGateFirstUserId },
      'account-gate-billing-gate-holder',
    );
    const waiterName = 'account-gate-billing-gate-writer';
    const billingAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.claim_billing_mutation_v3(
  'checkout',
  :'operation_id'::UUID,
  :'request_digest',
  :'user_id'::UUID
);`,
      ),
      {
        operation_id: billingOperationId,
        request_digest: REQUEST_DIGEST,
        user_id: billingGateFirstUserId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const billingResult = await billingAttempt;
      expect(billingResult.code).not.toBe(0);
      expect(billingResult.stderr).toContain('AD019');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: billingOperationId },
        ),
      ).toBe('0');
    } finally {
      await holder.release(false);
      await billingAttempt;
    }
  });

  it('rolls back begin after a Billing provider start commits first', async () => {
    const operationId = crypto.randomUUID();
    const customerId = `cus_test_${billingProviderStartFirstUserId.replaceAll('-', '')}`;
    const { error: profileError } = await admin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', billingProviderStartFirstUserId);
    expect(profileError).toBeNull();

    const { data: claimData, error: claimError } = await admin.rpc('claim_billing_mutation_v3', {
      p_mutation_kind: 'checkout',
      p_operation_id: operationId,
      p_request_digest: REQUEST_DIGEST,
      p_user_id: billingProviderStartFirstUserId,
    });
    expect(claimError).toBeNull();
    const leaseId = claimData?.[0]?.lease_id;
    if (!leaseId) throw new Error('Billing provider-start lease was not returned');

    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT public.start_billing_mutation_v2(
  :'operation_id'::UUID,
  :'lease_id'::UUID,
  :'customer_id',
  :'user_id'::UUID
);`,
      ).replace('COMMIT;', ''),
      {
        customer_id: customerId,
        lease_id: leaseId,
        operation_id: operationId,
        user_id: billingProviderStartFirstUserId,
      },
      'account-gate-billing-provider-start-holder',
    );
    const waiterName = 'account-gate-billing-provider-start-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: billingProviderStartFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).not.toBe(0);
      expect(beginResult.stderr).toContain('AD019');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
          { user_id: billingProviderStartFirstUserId },
        ),
      ).toBe('0');
      expect(
        ownerSql(
          `SELECT state
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: operationId },
        ),
      ).toBe('provider_started');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('rolls back begin after a Customer provider start commits first', async () => {
    const { leaseId, operationId } = await prepareCustomerProvisioning(customerStartFirstUserId);
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT public.start_billing_customer_provisioning_v2(
  :'lease_id'::UUID,
  :'operation_id'::UUID,
  :'user_id'::UUID
);`,
      ).replace('COMMIT;', ''),
      {
        lease_id: leaseId,
        operation_id: operationId,
        user_id: customerStartFirstUserId,
      },
      'account-gate-customer-start-holder',
    );
    const waiterName = 'account-gate-customer-start-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: customerStartFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).not.toBe(0);
      expect(beginResult.stderr).toContain('AD019');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
          { user_id: customerStartFirstUserId },
        ),
      ).toBe('0');
      expect(
        ownerSql(
          `SELECT state
FROM private.billing_customer_provisioning_attempts
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: operationId },
        ),
      ).toBe('provider_started');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('rejects Customer provider start after begin commits first', async () => {
    const { leaseId, operationId } = await prepareCustomerProvisioning(customerGateFirstUserId);
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ).replace('COMMIT;', ''),
      { user_id: customerGateFirstUserId },
      'account-gate-customer-gate-holder',
    );
    const waiterName = 'account-gate-customer-gate-start';
    const startAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT public.start_billing_customer_provisioning_v2(
  :'lease_id'::UUID,
  :'operation_id'::UUID,
  :'user_id'::UUID
);`,
      ),
      {
        lease_id: leaseId,
        operation_id: operationId,
        user_id: customerGateFirstUserId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const startResult = await startAttempt;
      expect(startResult.code).not.toBe(0);
      expect(startResult.stderr).toContain('AD019');
      expect(
        ownerSql(
          `SELECT state || ':' || terminal_reason
FROM private.billing_mutation_claims
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: operationId },
        ),
      ).toBe('abandoned:account_deletion_before_provider_start');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_customer_provisioning_attempts
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: operationId },
        ),
      ).toBe('0');
    } finally {
      await holder.release(false);
      await startAttempt;
    }
  });

  it('waits for exact expired Customer recovery before begin can commit', async () => {
    const { leaseId, operationId } = await prepareCustomerProvisioning(customerRecoveryFirstUserId);
    const customerId = `cus_race_${customerRecoveryFirstUserId.replaceAll('-', '')}`;
    const { data: started, error: startError } = await admin.rpc(
      'start_billing_customer_provisioning_v2',
      {
        p_lease_id: leaseId,
        p_operation_id: operationId,
        p_user_id: customerRecoveryFirstUserId,
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
      { operation_id: operationId },
    );

    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT public.complete_billing_customer_provisioning_v2(
  :'operation_id'::UUID,
  :'customer_id',
  :'user_id'::UUID
);`,
      ).replace('COMMIT;', ''),
      {
        customer_id: customerId,
        operation_id: operationId,
        user_id: customerRecoveryFirstUserId,
      },
      'account-gate-customer-recovery-holder',
    );
    const waiterName = 'account-gate-customer-recovery-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: customerRecoveryFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT stripe_customer_id
FROM public.profiles
WHERE id = :'user_id'::UUID;`,
          { user_id: customerRecoveryFirstUserId },
        ),
      ).toBe(customerId);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.billing_customer_provisioning_attempts
WHERE operation_id = :'operation_id'::UUID;`,
          { operation_id: operationId },
        ),
      ).toBe('0');
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM private.account_deletion_operations
WHERE user_id = :'user_id'::UUID;`,
          { user_id: customerRecoveryFirstUserId },
        ),
      ).toBe('1');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('lets a direct Plan writer finish before begin without reversing the global lock order', async () => {
    const planId = crypto.randomUUID();
    const holder = await holdTransaction(
      directTimeblockInsert('plans').replace('COMMIT;', ''),
      {
        end_at: '2040-01-01T01:00:00Z',
        start_at: '2040-01-01T00:00:00Z',
        timeblock_id: planId,
        title: 'Plan writer before account deletion begin',
        user_id: planWriterFirstUserId,
      },
      'account-gate-plan-writer-holder',
    );
    const waiterName = 'account-gate-plan-writer-begin';
    const beginAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ),
      { user_id: planWriterFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const beginResult = await beginAttempt;
      expect(beginResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM public.plans
WHERE id = :'plan_id'::UUID
  AND user_id = :'user_id'::UUID;`,
          { plan_id: planId, user_id: planWriterFirstUserId },
        ),
      ).toBe('1');
    } finally {
      await holder.release(false);
      await beginAttempt;
    }
  });

  it('lets a direct Record writer wait behind begin without deadlocking', async () => {
    const recordId = crypto.randomUUID();
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ).replace('COMMIT;', ''),
      { user_id: recordGateFirstUserId },
      'account-gate-record-gate-holder',
    );
    const waiterName = 'account-gate-record-gate-writer';
    const recordAttempt = runSqlAsync(
      directTimeblockInsert('records'),
      {
        end_at: '2020-01-01T01:00:00Z',
        start_at: '2020-01-01T00:00:00Z',
        timeblock_id: recordId,
        title: 'Record writer after account deletion begin',
        user_id: recordGateFirstUserId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const recordResult = await recordAttempt;
      expect(recordResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM public.records
WHERE id = :'record_id'::UUID
  AND user_id = :'user_id'::UUID;`,
          { record_id: recordId, user_id: recordGateFirstUserId },
        ),
      ).toBe('1');
    } finally {
      await holder.release(false);
      await recordAttempt;
    }
  });

  it('lets a direct Plan writer wait behind begin without deadlocking', async () => {
    const planId = crypto.randomUUID();
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT *
FROM public.begin_account_deletion_v1(:'user_id'::UUID);`,
      ).replace('COMMIT;', ''),
      { user_id: planGateFirstUserId },
      'account-gate-plan-gate-holder',
    );
    const waiterName = 'account-gate-plan-gate-writer';
    const planAttempt = runSqlAsync(
      directTimeblockInsert('plans'),
      {
        end_at: '2041-01-01T01:00:00Z',
        start_at: '2041-01-01T00:00:00Z',
        timeblock_id: planId,
        title: 'Plan writer after account deletion begin',
        user_id: planGateFirstUserId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const planResult = await planAttempt;
      expect(planResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM public.plans
WHERE id = :'plan_id'::UUID
  AND user_id = :'user_id'::UUID;`,
          { plan_id: planId, user_id: planGateFirstUserId },
        ),
      ).toBe('1');
    } finally {
      await holder.release(false);
      await planAttempt;
    }
  });

  it('webhookがprofile lockを先に取ってもAuth削除が完了する', async () => {
    const { customerId, subscriptionId } =
      await prepareReadyBillingAccountDeletion(webhookFirstUserId);
    const holder = await holdTransaction(
      serviceRoleTransaction(
        `SELECT public.sync_billing_subscription_deleted_v1(
  :'customer_id',
  :'subscription_id'
);`,
      ).replace('COMMIT;', ''),
      {
        customer_id: customerId,
        subscription_id: subscriptionId,
      },
      'account-gate-webhook-first-holder',
    );
    const waiterName = 'account-gate-webhook-first-delete';
    const deleteAttempt = runSqlAsync(
      `BEGIN;
DELETE FROM auth.users
WHERE id = :'user_id'::UUID;
COMMIT;`,
      { user_id: webhookFirstUserId },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);
      expect(holderResult.stdout).toContain('account_deleting');

      const deleteResult = await deleteAttempt;
      expect(deleteResult.code).toBe(0);
      expect(
        ownerSql(
          `SELECT pg_catalog.count(*)::TEXT
FROM auth.users
WHERE id = :'user_id'::UUID;`,
          { user_id: webhookFirstUserId },
        ),
      ).toBe('0');
    } finally {
      await holder.release(false);
      await deleteAttempt;
    }
  });

  it('Auth削除がprofile lockを先に取ったらwebhookをterminal receiptで終端する', async () => {
    const { customerId, subscriptionId } =
      await prepareReadyBillingAccountDeletion(deletionFirstUserId);
    const holder = await holdTransaction(
      `BEGIN;
DELETE FROM auth.users
WHERE id = :'user_id'::UUID;`,
      { user_id: deletionFirstUserId },
      'account-gate-delete-first-holder',
    );
    const waiterName = 'account-gate-delete-first-webhook';
    const webhookAttempt = runSqlAsync(
      serviceRoleTransaction(
        `SELECT public.sync_billing_subscription_deleted_v1(
  :'customer_id',
  :'subscription_id'
);`,
      ),
      {
        customer_id: customerId,
        subscription_id: subscriptionId,
      },
      waiterName,
    );

    try {
      await waitForApplicationLock(waiterName);
      const holderResult = await holder.release();
      expect(holderResult.code).toBe(0);

      const webhookResult = await webhookAttempt;
      expect(webhookResult.code).toBe(0);
      expect(webhookResult.stdout).toContain('account_deleted');
    } finally {
      await holder.release(false);
      await webhookAttempt;
    }
  });

  it('期限切れreceiptが別cleanupにlock中でもbacklogを報告する', async () => {
    const customerId = `cus_locked_${crypto.randomUUID().replaceAll('-', '')}`;
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
      { customer_id: customerId },
    );

    const holder = await holdTransaction(
      `BEGIN;
SELECT 1
FROM private.billing_account_deletion_terminal_receipts
WHERE stripe_customer_id_digest = pg_catalog.sha256(
  pg_catalog.convert_to(:'customer_id', 'UTF8')
)
FOR UPDATE;`,
      { customer_id: customerId },
      'account-gate-billing-receipt-cleanup-holder',
    );

    try {
      const { data, error } = await admin.rpc(
        'cleanup_billing_account_deletion_terminal_receipts_v2',
        { p_limit: 1 },
      );
      expect(error).toBeNull();
      expect(data?.[0]).toEqual({
        deleted_count: 0,
        has_more: true,
      });
    } finally {
      await holder.release();
    }

    const { data: cleanupData, error: cleanupError } = await admin.rpc(
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      { p_limit: 1 },
    );
    expect(cleanupError).toBeNull();
    expect(cleanupData?.[0]).toEqual({
      deleted_count: 1,
      has_more: false,
    });
  });
});
