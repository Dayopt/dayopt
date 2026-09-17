/** Read-only provider audit. Emits a reviewable migration; never applies it. */
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';
import Stripe from 'stripe';

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output?.endsWith('.sql'))
    throw new Error('Usage: tsx scripts/billing-trial-preflight.ts /absolute/path/review.sql');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!url || !key || !stripeKey)
    throw new Error('Provider credentials are required; no output generated');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const stripe = new Stripe(stripeKey);
  const consume: string[] = [];
  let eligible = 0;
  let existing = 0;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from('profiles')
      .select('id,stripe_customer_id,subscription_status,app_trial_consumed_at')
      .order('id')
      .range(offset, offset + 499);
    if (error || !data) throw new Error('Profile audit failed; no output generated');
    for (const profile of data) {
      if (profile.app_trial_consumed_at) {
        existing++;
        continue;
      }
      if (!/^[0-9a-f-]{36}$/i.test(profile.id)) throw new Error('Invalid profile identity');
      if (!profile.stripe_customer_id) {
        if (profile.subscription_status !== 'free')
          throw new Error('Unresolved billing identity; no output generated');
        eligible++;
        continue;
      }
      let usedIntro = false;
      for await (const subscription of stripe.subscriptions.list({
        customer: profile.stripe_customer_id,
        status: 'all',
        limit: 100,
      })) {
        if (subscription.trial_start !== null) usedIntro = true;
      }
      for await (const invoice of stripe.invoices.list({
        customer: profile.stripe_customer_id,
        limit: 100,
      })) {
        if (
          invoice.status === 'paid' &&
          invoice.amount_paid > 0 &&
          invoice.parent?.type === 'subscription_details'
        )
          usedIntro = true;
      }
      if (usedIntro) consume.push(profile.id);
      else eligible++;
    }
    if (data.length < 500) break;
  }
  const statements = consume.map(
    (id) =>
      `UPDATE public.profiles SET app_trial_consumed_at = COALESCE(app_trial_consumed_at, now()) WHERE id = '${id}'::uuid;`,
  );
  await writeFile(
    output,
    [
      '-- REVIEW ONLY. Requires explicit Production authority and backup.',
      '-- Run under the rollout write fence after repeating this audit.',
      'BEGIN;',
      "SET LOCAL lock_timeout = '5s';",
      ...statements,
      'COMMIT;',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      eligible,
      alreadyConsumed: existing,
      historicalConsumers: consume.length,
      stripeMode: stripeKey.startsWith('sk_test_') ? 'test' : 'live',
      applied: false,
    }) + '\n',
  );
}
main().catch(() => {
  process.stderr.write(
    'Billing preflight failed. No migration should be applied; resolve provider access or classification first.\n',
  );
  process.exitCode = 1;
});
