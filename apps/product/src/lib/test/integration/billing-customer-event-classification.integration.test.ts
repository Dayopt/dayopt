import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const USER_ID = crypto.randomUUID();
const CUSTOMER_ID = `cus_live_${USER_ID.replaceAll('-', '')}`;

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

describe.skipIf(!RUN_LOCAL)('billing Customer event classification', () => {
  beforeAll(async () => {
    const { error: createError } = await admin.auth.admin.createUser({
      id: USER_ID,
      email: `billing-classification-${USER_ID}@example.com`,
      email_confirm: true,
      password: 'test-password-123',
    });
    if (createError) throw createError;

    const { error: profileError } = await admin
      .from('profiles')
      .update({ stripe_customer_id: CUSTOMER_ID })
      .eq('id', USER_ID);
    if (profileError) throw profileError;
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(USER_ID);
  });

  it('live Customerとunknown Customerを区別する', async () => {
    const live = await admin.rpc('classify_billing_customer_event_v1', {
      p_stripe_customer_id: CUSTOMER_ID,
    });
    expect(live.error).toBeNull();
    expect(live.data).toBe('live');

    const unknown = await admin.rpc('classify_billing_customer_event_v1', {
      p_stripe_customer_id: 'cus_unknown_fixture',
    });
    expect(unknown.error).toBeNull();
    expect(unknown.data).toBe('unknown_customer');
  });

  it('browser roleからは実行できない', async () => {
    const result = await anonymous.rpc('classify_billing_customer_event_v1', {
      p_stripe_customer_id: CUSTOMER_ID,
    });
    expect(result.error).not.toBeNull();
  });
});
