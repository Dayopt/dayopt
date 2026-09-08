import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { logger } from '@/lib/logger';
import { observeAuthOperation } from '@/lib/sentry';

export type MfaAssuranceLevel = 'aal1' | 'aal2';

export interface MfaAssurance {
  currentLevel: MfaAssuranceLevel | null;
  nextLevel: MfaAssuranceLevel | null;
  lookupFailed?: boolean | undefined;
}

interface SessionAuthContext {
  userId?: string | undefined;
  sessionId?: string | undefined;
  mfaAssurance?: MfaAssurance | undefined;
}

type SessionAuthOperationPrefix =
  'trpc_context' | 'rsc_trpc' | 'calendar_connect' | 'proxy' | 'recovery_codes';

function createFailedMfaAssurance(): MfaAssurance {
  return {
    currentLevel: null,
    nextLevel: null,
    lookupFailed: true,
  };
}

/** SupabaseはAAL claimがない従来sessionをnullで返すため、AAL1として扱う。 */
function normalizeMfaAssuranceLevel(level: unknown): MfaAssuranceLevel | undefined {
  if (level === null || level === 'aal1') return 'aal1';
  if (level === 'aal2') return 'aal2';
  return undefined;
}

/**
 * aal2 → aal1 の降格は常に許可する（#2150）。MFA無効化直後は
 * `currentLevel`（JWT由来、token refreshまでaal2のまま）と`nextLevel`
 * （実際のfactor状態から算出、既にaal1）がこの組み合わせになる正常状態で、
 * aal2は要求水準を満たしている側なので許可しても権限昇格にはならない。
 */
export function isValidMfaAssuranceTransition(currentLevel: unknown, nextLevel: unknown): boolean {
  if (currentLevel === 'aal1') return nextLevel === 'aal1' || nextLevel === 'aal2';
  return currentLevel === 'aal2' && (nextLevel === 'aal1' || nextLevel === 'aal2');
}

/** HTTP/RSCのsession contextへ同じ認証情報とfail-closed MFA状態を設定する。 */
export async function resolveSessionAuthContext(
  supabase: SupabaseClient<Database>,
  operationPrefix: SessionAuthOperationPrefix,
): Promise<SessionAuthContext> {
  let userId: string | undefined;

  try {
    // getUser()でAuth serverに問い合わせ、cookie由来JWTを検証する。
    const {
      data: { user },
      error: userError,
    } = await observeAuthOperation(`${operationPrefix}_get_user`, () => supabase.auth.getUser());

    if (userError || !user) return {};
    userId = user.id;
  } catch {
    // 未検証のuserIdはcontextへ入れず、protectedProcedureでUNAUTHORIZEDにする。
    return {};
  }

  let sessionId: string | undefined;
  try {
    const {
      data: { session },
      error: sessionError,
    } = await observeAuthOperation(`${operationPrefix}_get_session`, () =>
      supabase.auth.getSession(),
    );
    if (sessionError) {
      logger.warn('Session token lookup failed');
    } else {
      sessionId = session?.access_token;
    }
  } catch {
    // session tokenはログ用であり、失敗しても独立したMFA lookupを継続する。
    logger.warn('Session token lookup threw');
  }

  const mfaAssurance = await resolveMfaAssurance(supabase, operationPrefix);

  return { userId, sessionId, mfaAssurance };
}

/**
 * MFA assurance level を解決する唯一の判定源。`proxy.ts` の MFA redirect 判定・
 * `protectedProcedure` の tRPC guard（`resolveSessionAuthContext` 経由）・
 * Google Calendar 接続 Route Handler の 3 箇所すべてがこの関数を呼ぶ（#2047）。
 * **3 箇所とも、この関数を呼ぶ前に `supabase.auth.getUser()` で user を server
 * 検証済みにしている前提**（`!accessToken` 分岐が fail-open で aal1 を返すのは
 * この前提の上でのみ安全。検証していない呼び出し元を新規に足す場合は要注意）。
 *
 * `getAuthenticatorAssuranceLevel()` を jwt 引数なしで呼ぶと、AAL claim は
 * server 未検証の session storage（cookie 由来）から読まれる。`@supabase/ssr` の
 * server client は session JSON 全体（`user.factors` 含む）を cookie に保存するため、
 * cookie を書き換えて `factors` を削るだけで MFA 検証済み判定を回避できてしまう。
 * jwt 引数（`session.access_token`）を渡すと、SDK 内部で `getUser(jwt)` を呼んで
 * Auth server へ問い合わせ、server 検証済みの factors で判定する。
 *
 * 呼び出し元は既に `getUser()` で server 検証済みの user（factors 含む）を持って
 * いるため、この内部 `getUser(jwt)` は同一 request 内で 2 回目の `/user` 往復に
 * なる（実装の単純さ・SDK の判定ロジックをそのまま使う安全性を優先した選択。
 * 往復を 1 回に減らすなら、呼び出し元の検証済み user から自前で currentLevel/
 * nextLevel を算出する形へ再設計が要るが、それは SDK の判定ロジックの再実装に
 * なるため別途検討する）。
 */
export async function resolveMfaAssurance(
  supabase: SupabaseClient<Database>,
  operationPrefix: SessionAuthOperationPrefix,
): Promise<MfaAssurance> {
  try {
    const { data: sessionData, error: sessionError } = await observeAuthOperation(
      `${operationPrefix}_get_session_for_mfa`,
      () => supabase.auth.getSession(),
    );

    if (sessionError) {
      logger.warn('MFA assurance session lookup failed');
      return createFailedMfaAssurance();
    }

    const accessToken = sessionData.session?.access_token;

    // sessionが無い場合はAAL claim自体が存在しないため、従来通りaal1として扱う
    // （normalizeMfaAssuranceLevelのnull→aal1正規化と同じ契約）。呼び出し元が
    // 事前にgetUser()でuserを検証済みという前提のもとでのみfail-openとして安全
    // （関数doc参照）。
    if (!accessToken) {
      return { currentLevel: 'aal1', nextLevel: 'aal1' };
    }

    const { data: aalData, error: aalError } = await observeAuthOperation(
      `${operationPrefix}_get_authenticator_assurance_level`,
      () => supabase.auth.mfa.getAuthenticatorAssuranceLevel(accessToken),
    );
    const currentLevel = normalizeMfaAssuranceLevel(aalData?.currentLevel);
    const nextLevel = normalizeMfaAssuranceLevel(aalData?.nextLevel);

    if (
      aalError ||
      currentLevel === undefined ||
      nextLevel === undefined ||
      !isValidMfaAssuranceTransition(currentLevel, nextLevel)
    ) {
      logger.warn('MFA assurance lookup failed');
      return createFailedMfaAssurance();
    }

    return { currentLevel, nextLevel };
  } catch {
    logger.warn('MFA assurance lookup threw');
    return createFailedMfaAssurance();
  }
}
