import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const RAW_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const USER_ID = crypto.randomUUID();

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function runOwnerSql(sql: string): string {
  return execFileSync('psql', [RAW_DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: sql,
  }).trim();
}

describe.skipIf(!RUN_LOCAL)('PostHog first-paid invoice marker', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: USER_ID,
      email: `posthog-first-paid-${USER_ID}@example.com`,
      email_confirm: true,
      password: 'test-password-123',
    });
    if (error) throw error;
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(USER_ID);
  });

  it('keeps the first invoice idempotent after old product events are pruned', async () => {
    const firstInvoiceEventId = crypto.randomUUID();
    const laterInvoiceEventId = crypto.randomUUID();
    const first = await admin.rpc('claim_posthog_first_paid_invoice_v1', {
      p_user_id: USER_ID,
      p_invoice_event_id: firstInvoiceEventId,
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);

    const staleProductEventId = crypto.randomUUID();
    const staleEvent = await admin.from('product_events').insert({
      id: staleProductEventId,
      user_id: USER_ID,
      event_name: 'subscription_payment_succeeded',
      properties: {},
      created_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    expect(staleEvent.error).toBeNull();
    expect(
      runOwnerSql(
        `DELETE FROM public.product_events WHERE id = '${staleProductEventId}'::uuid RETURNING id;`,
      ),
    ).toBe(staleProductEventId);

    const retry = await admin.rpc('claim_posthog_first_paid_invoice_v1', {
      p_user_id: USER_ID,
      p_invoice_event_id: firstInvoiceEventId,
    });
    expect(retry.error).toBeNull();
    expect(retry.data).toBe(true);

    const later = await admin.rpc('claim_posthog_first_paid_invoice_v1', {
      p_user_id: USER_ID,
      p_invoice_event_id: laterInvoiceEventId,
    });
    expect(later.error).toBeNull();
    expect(later.data).toBe(false);
  });

  it('allows only the service-role claim RPC and removes the marker with the account', async () => {
    const privilegeSnapshot = runOwnerSql(`
      SELECT
        pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'SELECT'),
        pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'INSERT'),
        pg_catalog.has_function_privilege('service_role', 'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)', 'EXECUTE'),
        pg_catalog.has_function_privilege('authenticated', 'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)', 'EXECUTE'),
        pg_catalog.has_function_privilege('anon', 'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)', 'EXECUTE');
    `);
    expect(privilegeSnapshot).toBe('f|f|t|f|f');

    const denied = await anonymous.rpc('claim_posthog_first_paid_invoice_v1', {
      p_user_id: USER_ID,
      p_invoice_event_id: crypto.randomUUID(),
    });
    expect(denied.error).not.toBeNull();

    const deleted = await admin.auth.admin.deleteUser(USER_ID);
    expect(deleted.error).toBeNull();
    expect(
      runOwnerSql(
        `SELECT count(*) FROM private.posthog_first_paid_invoices WHERE user_id = '${USER_ID}'::uuid;`,
      ),
    ).toBe('0');
  });
});
