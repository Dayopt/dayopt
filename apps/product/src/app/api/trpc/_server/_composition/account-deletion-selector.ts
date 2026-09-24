import 'server-only';

import { deleteLegacyBillingAccountData } from '@/features/settings/server/account-deletion';
import { deletePostHogAccountData } from '@/lib/analytics/posthog-deletion';
import { getExternalLifecycleAppVersion } from '@/lib/database/external-lifecycle-version';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import { prepareAccountDeletionBeforeIdentityDeletion } from './account-deletion-coordinator';

type AccountDeletionPreparationResult = {
  status: 'completed' | 'contention';
};

async function prepareLegacyAccountDeletion(
  userId: string,
): Promise<AccountDeletionPreparationResult> {
  const db = createServiceRoleClient();

  try {
    const { data: files, error: listError } = await db.storage.from('avatars').list(userId);
    if (listError) throw new Error('Avatar listing failed', { cause: listError });
    if (files && files.length > 0) {
      const filePaths = files.map((file) => `${userId}/${file.name}`);
      const { error: removeError } = await db.storage.from('avatars').remove(filePaths);
      if (removeError) throw new Error('Avatar removal failed', { cause: removeError });
    }

    await deleteLegacyBillingAccountData(userId);
    await deletePostHogAccountData({ userId });

    return { status: 'completed' };
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error('Legacy account deletion preparation failed');
    captureUnexpectedError(failure, {
      feature: 'account_deletion',
      operation: 'prepare_legacy_identity_deletion',
      source: 'account_deletion_selector',
    });
    throw failure;
  }
}

/**
 * Candidate 3 mixed-version boundary.
 *
 * - Missing predecessor RPC or an inactive, idle gate keeps the current deletion path.
 * - An active gate uses the durable Calendar -> Storage -> Billing coordinator.
 * - Any inconsistent or unreadable state fails closed.
 *
 * The legacy branch is temporary and must be removed only after old instances drain and
 * the account/Calendar activation checkpoint succeeds.
 */
export async function prepareAccountDeletionWithCompatibility(input: {
  userId: string;
}): Promise<AccountDeletionPreparationResult> {
  const db = createServiceRoleClient();
  const lifecycleVersion = await getExternalLifecycleAppVersion(db);
  if (lifecycleVersion === 0) {
    return prepareLegacyAccountDeletion(input.userId);
  }

  const { data, error } = await db.rpc('get_account_deletion_readiness_v1');

  if (error) {
    throw new Error('Account deletion readiness could not be verified', { cause: error });
  }

  if (!data || data.length !== 1) {
    throw new Error('Account deletion readiness is inconsistent');
  }

  const [readiness] = data;
  if (readiness === undefined) {
    throw new Error('Account deletion readiness is inconsistent');
  }
  if (readiness.activated) {
    return prepareAccountDeletionBeforeIdentityDeletion(input);
  }
  if (readiness.active_operations !== 0) {
    throw new Error('Inactive account deletion gate has active operations');
  }

  return prepareLegacyAccountDeletion(input.userId);
}
