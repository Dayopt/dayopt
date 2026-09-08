'use server';

import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/auth/recovery-codes';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedDatabaseError, observeAuthOperation } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { createClient } from '@/lib/supabase/server';
import { resolveMfaAssurance } from '@/lib/trpc/session-auth-context';

const RECOVERY_CODE_FAILURE = 'Failed to generate recovery codes';
/** 第二要素を通していないセッションからの発行を拒む時の理由（#2618） */
const RECOVERY_CODE_MFA_REQUIRED = 'MFA verification is required to issue recovery codes';

function captureRecoveryCodeFailure(error: unknown, operation: string): void {
  captureUnexpectedDatabaseError(error, {
    feature: 'mfa_recovery_codes',
    operation,
  });
}

/**
 * リカバリーコードを生成しDBに保存する Server Action
 *
 * recovery-codes.ts は server-only のため client component から直接 import できない。
 * この Server Action を経由することで client/server 境界を正しく分離する。
 *
 * @security #2618
 * 2 つの境界をここで引く。
 *
 * 1. **aal2 を要求する。** リカバリコードは第二要素と等価な credential なので、第二要素を
 *    通していないセッションからは発行させない。以前は MFA を持たないユーザーでも呼べたため、
 *    攻撃者が捨てアカウントで (平文, `code_hash`) の組を学ぶ入口になっていた。
 *    正規の経路は両方とも aal2 を満たす: 登録直後は `mfa.verify()` で昇格済み、
 *    設定画面からの再発行は MFA 済みユーザーのセッション
 * 2. **書き込みは service_role の RPC 経由。** `mfa_recovery_codes` への直接 DML は
 *    anon / authenticated から revoke 済みで、認証主体は自分の行を植えられない。
 *    削除と挿入は `replace_mfa_recovery_codes_v1` が 1 tx で行うので、旧コードが
 *    生き残る窓もない
 */
export async function generateAndSaveRecoveryCodesAction(): Promise<{
  codes: string[] | null;
  error: string | null;
}> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await observeAuthOperation('recovery_codes_get_user', () => supabase.auth.getUser());

    if (!user) {
      return { codes: null, error: 'User not found' };
    }

    // fail-closed: assurance を確定できない場合も発行しない。
    const assurance = await resolveMfaAssurance(supabase, 'recovery_codes');
    if (assurance.lookupFailed || assurance.currentLevel !== 'aal2') {
      return { codes: null, error: RECOVERY_CODE_MFA_REQUIRED };
    }

    if (await isWriteFenceEnabled(supabase)) {
      return { codes: null, error: 'Writes are temporarily paused for maintenance' };
    }

    const codes = generateRecoveryCodes();

    // 旧コードの削除と新コードの挿入は RPC 側の 1 tx。
    const adminClient = createServiceRoleClient();
    const { error: replaceError } = await adminClient.rpc('replace_mfa_recovery_codes_v1', {
      p_user_id: user.id,
      p_code_hashes: codes.map((code) => hashRecoveryCode(code)),
    });

    if (replaceError) {
      captureRecoveryCodeFailure(replaceError, 'replace_recovery_codes');
      return { codes: null, error: RECOVERY_CODE_FAILURE };
    }

    return { codes, error: null };
  } catch (err) {
    captureRecoveryCodeFailure(err, 'generate_and_save_codes');
    return { codes: null, error: RECOVERY_CODE_FAILURE };
  }
}
