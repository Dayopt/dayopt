import 'server-only';

/**
 * User Service
 *
 * ユーザー管理のビジネスロジック
 * tRPCルーターから呼び出されるサービス層
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailLocale } from '@/emails/i18n';
import { getAppUrl } from '@/lib/app-url';
import type {
  Database,
  PublicPlanRow,
  PublicRecordRow,
  PublicUserSettingsRow,
  Row,
} from '@/lib/database';
import {
  databaseTables,
  publicPlanSelect,
  publicRecordSelect,
  publicUserSettingsSelect,
} from '@/lib/database';
import { getUserLocale, sendAccountDeletionEmail } from '@/lib/email/router';
import { logger } from '@/lib/logger';
import {
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
  isExpectedAuthError,
  observeAuthOperation,
} from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { ServiceError } from '@/lib/trpc/errors';

import {
  enforceReauthRateLimit,
  verifyPasswordWithCaptchaBypass,
} from './password-reauthentication';

/**
 * `updateUser({ email })` の失敗のうち、`isExpectedAuthError` が expected と判定しても
 * なお Sentry へ alert したい GoTrue error code（#2064）。allowlist 方式（class ごと閉じる）。
 *
 * 判定は `!isExpectedAuthError(updateError) || EMAIL_UPDATE_ALERTING_CODES.has(code)`
 * — つまり既定は「`isExpectedAuthError` に従う」（false=expected=静音、true=alert）で、
 * このリストは「expected 判定を上書きしてでも alert したい」例外だけを持つ。
 *
 * ⚠ silence 側の列挙（`isExpectedAuthError` が false を返す code だけ静音化し、それ以外を
 * 一律 alert）は採らない。`updateUser` はユーザー自身の session-scoped client で呼ぶため、
 * `session_expired` / `bad_jwt` / `no_authorization` / `user_banned` / `user_not_found` /
 * `insufficient_aal` / `conflict` 等の session/権限系 expected code がユーザーフローの
 * 正常な帰結として頻発しうる（`password-reauthentication.ts` の移植元は service-role
 * client なのでこれらが構造的に発生せず、silence 3 件で足りていた — 前提が異なる）。
 * silence 列挙だとこれら全てが誤 alert のノイズ源になる。allowlist 反転なら
 * `EXPECTED_AUTH_ERROR_CODES` が将来増えても追随不要で、狙った code だけを確実に拾える。
 *
 * `email_address_not_authorized` を含める: GoTrue の既定 SMTP は組織メンバー以外への
 * 送信を拒否するため、production で custom SMTP が正しく設定されていれば個々の
 * ユーザー操作では原則発生しない。発生したら SMTP 設定が意図せず外れている signal
 * として扱い、メール変更が全滅していても気づけるようにする。
 *
 * `validation_failed` は含めない（`EXPECTED_AUTH_ERROR_CODES` に従い静音）が両義的:
 * router 側で `z.string().email()` により newEmail の形式は事前検証済みなので、
 * 典型的にはユーザー起因のタイプミスではなく GoTrue 側の追加バリデーション（Zod より
 * 厳格な規則）差分を指す可能性の方が高い。ただし `emailRedirectTo` 等こちら側の
 * payload 不整合（#2064 が拾いたい「全滅」パターン）でも同じ code で返りうるため、
 * 判別できない。現時点でこの code が実運用で問題になった実績が無いため静音を維持するが、
 * 頻発が疑われたら allowlist へ昇格させる
 *
 * `handleServiceError` の自動報告（`!isExpectedAuthError(original)` でゲート）はこの
 * allowlist を知らないため、alert 対象でも自動報告経路には乗らない。だから throw 直前で
 * `captureUnexpectedError` を直接呼ぶ（`password-reauthentication.ts` L168-186 の canary
 * と同型）。`updateUser` 呼び出しは `observeAuthOperation` で包んだままのため、
 * expected でない code（未知 code や 5xx 等）は observeAuthOperation 側が先に
 * `updateError` を capture 済みのことがある。二重 issue を避けるため、直接呼び出しは
 * **必ず `updateError` そのもの**（新しい Error でラップしない）を渡す —
 * `captureUnexpectedError` の WeakSet dedup は同一 instance にしか効かない
 */
const EMAIL_UPDATE_ALERTING_CODES = new Set(['email_address_not_authorized']);

/**
 * GoTrue の rate limit。`password-reauthentication.ts` の `RATE_LIMITED_STATUS` と同型。
 * `over_email_send_rate_limit` / `over_request_rate_limit` は `EXPECTED_AUTH_ERROR_CODES`
 * 側で既に expected（status 429 の fallback も掛かる）なので alert 判定には関与しない。
 * ここでは頻発時に追えるよう warn ログだけ残す（rate limit は構成故障とユーザー集中
 * アクセスの両方であり得るため、Sentry へは送らない）
 */
const EMAIL_UPDATE_RATE_LIMITED_STATUS = 429;

/**
 * User Service エラー
 */
export class UserServiceError extends ServiceError {
  constructor(
    code:
      | 'DELETE_FAILED'
      | 'DELETE_DATA_FAILED'
      | 'EXPORT_FAILED'
      | 'UNAUTHORIZED'
      | 'INVALID_PASSWORD'
      | 'REAUTH_UNAVAILABLE'
      | 'INVALID_INPUT'
      | 'CONFLICT'
      | 'EMAIL_UPDATE_FAILED'
      | 'EMAIL_UPDATE_UNAVAILABLE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message);
    this.name = 'UserServiceError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * アカウント削除オプション
 */
interface DeleteAccountOptions {
  userId: string;
  userEmail: string;
  /** 表示名。削除通知メールの宛名に使う */
  userName: string;
  /** パスワードを持つユーザーのみ必須 */
  password?: string | undefined;
  /** パスワードを持たないユーザーが MFA を有効にしている場合に必須 */
  totpCode?: string | undefined;
  /**
   * パスワードで再認証すべきユーザーか。
   * クライアント入力ではなく server 側の `app_metadata` から判定した値を渡すこと
   */
  requiresPassword: boolean;
  confirmText: string;
}

/**
 * データエクスポートオプション
 */
interface ExportDataOptions {
  userId: string;
}

/**
 * メールアドレス変更オプション
 */
interface RequestEmailChangeOptions {
  userId: string;
  /** server 側の session から取得したアドレス。クライアント入力を渡さないこと */
  currentEmail: string;
  newEmail: string;
  password: string;
}

/**
 * アカウント削除レスポンス
 */
interface DeleteAccountResult {
  success: true;
}

/**
 * メールアドレス変更レスポンス
 */
interface RequestEmailChangeResult {
  success: true;
}

export type UserServiceDependencies = Readonly<{
  beforeIdentityDeletion: (input: {
    userId: string;
  }) => Promise<{ status: 'completed' | 'contention' }>;
}>;

/**
 * データエクスポートレスポンス
 */
interface ExportDataResult {
  exportedAt: string;
  userId: string;
  data: {
    profile: Row<'profiles'> | null;
    plans: PublicPlanRow[];
    records: PublicRecordRow[];
    categories: Row<'categories'>[];
    activities: Row<'activities'>[];
    userSettings: PublicUserSettingsRow | null;
  };
}

/**
 * User Service ファクトリ
 */
export function createUserService(
  supabase: SupabaseClient<Database>,
  dependencies: UserServiceDependencies,
) {
  return {
    /**
     * アカウント即時削除
     *
     * auth.users を削除すると CASCADE DELETE により
     * plans / records / activities / categories 等すべてのユーザーデータが自動削除される
     */
    async deleteAccount(options: DeleteAccountOptions): Promise<DeleteAccountResult> {
      const { userId, userEmail, userName, password, totpCode, requiresPassword, confirmText } =
        options;

      if (confirmText !== 'DELETE') {
        throw new UserServiceError('INVALID_INPUT', 'Confirmation text must be "DELETE"');
      }

      // 再認証。ユーザーが実際に持っている手段で確認する
      // （Google のみのユーザーはパスワードを持たないため、パスワードに固定しない）
      if (requiresPassword) {
        if (!password) {
          throw new UserServiceError('INVALID_INPUT', 'Password is required');
        }

        // 公開 Auth endpoint を user-scoped client で叩くと production の Bot Protection で
        // 必ず captcha_failed になる（#1917 と同じ故障クラス）。削除には current_password や
        // Secure Email Change に相当する GoTrue 側の代替機構が無いため、service-role 経由で
        // captcha を免除する。免除の意味と契約は password-reauthentication.ts を読むこと
        //
        // rate limit は verifyPasswordWithCaptchaBypass の直前で明示的に強制する
        // （email 変更フローと bucket を分離し、GoTrue の IP 共有バケット消費も頭打ちにする）
        await enforceReauthRateLimit(userId, 'account_deletion');
        const reauthentication = await verifyPasswordWithCaptchaBypass({
          email: userEmail,
          password,
          context: 'account_deletion',
        });

        if (reauthentication.outcome === 'invalid_password') {
          throw new UserServiceError('INVALID_PASSWORD', 'Invalid password');
        }

        if (reauthentication.outcome !== 'verified') {
          // 検証手段が使えない時は削除を通さない（fail closed）。原因は
          // password-reauthentication.ts 側で Sentry へ送っているので message には載せない
          throw new UserServiceError('REAUTH_UNAVAILABLE', 'Reauthentication unavailable');
        }
      } else {
        // パスワードを持たないユーザーは、MFA があれば TOTP で再認証する
        const { data: factors, error: factorsError } = await observeAuthOperation(
          'delete_account_list_factors',
          () => supabase.auth.mfa.listFactors(),
        );

        if (factorsError) {
          // 検証手段を確認できない状態では削除を通さない（fail closed）
          throw new UserServiceError('DELETE_FAILED', 'Failed to verify authentication factors');
        }

        const verifiedTotp = factors?.totp?.find((factor) => factor.status === 'verified');
        if (verifiedTotp) {
          if (!totpCode) {
            throw new UserServiceError('INVALID_INPUT', 'Verification code is required');
          }

          const { error: mfaError } = await observeAuthOperation('delete_account_verify_totp', () =>
            supabase.auth.mfa.challengeAndVerify({
              factorId: verifiedTotp.id,
              code: totpCode,
            }),
          );

          if (mfaError) {
            throw new UserServiceError('INVALID_PASSWORD', 'Invalid verification code');
          }
        }
        // MFA も無い場合は、確認テキストの明示入力と削除通知メールで担保する
      }

      // 通知メールの locale は user_settings 由来。削除で CASCADE 消滅するため先に引いておく
      // （メール本文は「削除されました」と完了を伝えるので、送信自体は削除確定後に行う）
      let emailLocale: EmailLocale = 'en';
      try {
        emailLocale = await getUserLocale(supabase, userId);
      } catch {
        // locale が引けなくても既定言語で送れるので削除は続ける
      }

      // Composition layer が gate 状態に応じて現行互換経路または
      // Calendar -> Storage -> Billing のdurable経路を選ぶ。
      try {
        const preparation = await dependencies.beforeIdentityDeletion({ userId });
        if (preparation.status === 'contention') {
          throw new UserServiceError('CONFLICT', 'Account deletion is busy. Try again.');
        }
      } catch (error) {
        if (error instanceof UserServiceError) throw error;
        const failure = new Error('Account deletion preparation failed', { cause: error });
        captureUnexpectedError(failure, {
          feature: 'account_deletion',
          operation: 'prepare_identity_deletion',
          source: 'account_deletion_dependency',
        });
        throw new UserServiceError('DELETE_FAILED', 'Failed to prepare account deletion', {
          cause: failure,
        });
      }

      // auth.users を削除 → CASCADE DELETE により全テーブルのユーザーデータが自動削除される
      const adminClient = createServiceRoleClient();
      const { error: deleteError } = await observeAuthOperation(
        'delete_account_admin_delete_user',
        () => adminClient.auth.admin.deleteUser(userId),
        { feature: 'account_deletion' },
      );

      if (deleteError) {
        throw new UserServiceError('DELETE_FAILED', 'Failed to delete account', {
          cause: deleteError,
        });
      }

      logger.info('Account deleted successfully', { userId });

      // 削除が確定してから通知する。送信失敗で削除をなかったことにはできないので、
      // 記録だけ残して成功を返す（GDPR の削除要求を優先する）
      try {
        await sendAccountDeletionEmail({
          email: userEmail,
          userName,
          locale: emailLocale,
        });
      } catch (emailError) {
        const original =
          emailError instanceof Error
            ? emailError
            : new Error('Account deletion email failed', { cause: emailError });
        captureUnexpectedError(original, {
          feature: 'account_deletion',
          operation: 'send_deletion_email',
          source: 'resend',
        });
      }

      return { success: true };
    },

    /**
     * メールアドレス変更（変更前パスワード再認証つき）
     *
     * 本人確認は Secure Email Change（`supabase/config.toml` の `double_confirm_changes = true`、
     * server 強制ゲート）に**加えて**、変更前パスワード再認証（service-role 経由 captcha 免除、
     * app 層の追加防御）を要求する。#2024 の中間案 — 双方確認は手放さない。
     *
     * `updateUser` はユーザー自身の session-scoped client（service-role ではない）で呼ぶ。
     * パスワード検証だけが captcha 免除の service-role 経由で、email 変更の実行主体は
     * 引き続き本人のまま。double_confirm_changes が true のため、この呼び出しは今までどおり
     * 新旧両アドレスへ確認メールを送る。
     */
    async requestEmailChange(
      options: RequestEmailChangeOptions,
    ): Promise<RequestEmailChangeResult> {
      const { userId, currentEmail, newEmail, password } = options;

      // 大文字小文字・前後空白だけが違う「同じアドレス」もここで弾く（GoTrue は正規化して
      // 扱うため、これを見逃すと reauth rate limit と GoTrue の共有 IP バケットを
      // 無駄に消費したうえで実質 no-op の変更が通ってしまう）。newEmail 自体は
      // 正規化せずそのまま updateUser に渡す（ユーザーの入力をサイレントに書き換えない）
      if (newEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase()) {
        throw new UserServiceError('INVALID_INPUT', 'New email must differ from current email');
      }

      // rate limit は verifyPasswordWithCaptchaBypass の直前で明示的に強制する。
      // account 削除と bucket を分離するため context を渡す（同じパターンは deleteAccount 参照）
      await enforceReauthRateLimit(userId, 'email_change');
      const reauthentication = await verifyPasswordWithCaptchaBypass({
        email: currentEmail,
        password,
        context: 'email_change',
      });

      if (reauthentication.outcome === 'invalid_password') {
        throw new UserServiceError('INVALID_PASSWORD', 'Invalid password');
      }

      if (reauthentication.outcome !== 'verified') {
        // 検証手段が使えない時は変更を通さない（fail closed）。原因は
        // password-reauthentication.ts 側で Sentry へ送っているので message には載せない
        throw new UserServiceError('REAUTH_UNAVAILABLE', 'Reauthentication unavailable');
      }

      const { error: updateError } = await observeAuthOperation(
        'update_email',
        () =>
          supabase.auth.updateUser(
            { email: newEmail },
            { emailRedirectTo: `${getAppUrl()}/settings/account` },
          ),
        { feature: 'email_change' },
      );

      if (updateError) {
        if (updateError.status === EMAIL_UPDATE_RATE_LIMITED_STATUS) {
          // 単発は静音のまま畳むが、頻発は目視で追えるよう warn ログだけ残す
          // （Sentry へは送らない。rate limit は正常なユーザー集中アクセスでも起こる）。
          // userId を構造化引数で渡す — 単一ユーザーの連打か全体枯渇かを切り分けるため
          // （breadcrumb には固定文言のみ乗り、userId は含まれない。logger.ts 参照）
          logger.warn('Email update rate limited by GoTrue', {
            userId,
            message: updateError.message,
          });
        }

        // allowlist 方式（#2064）: 既定は isExpectedAuthError に従う（false=expected=静音）。
        // EMAIL_UPDATE_ALERTING_CODES は「expected 判定を上書きしてでも alert したい」
        // 例外だけを持つ（詳細は同定数の doc comment）
        const shouldAlert =
          !isExpectedAuthError(updateError) ||
          (updateError.code !== undefined && EMAIL_UPDATE_ALERTING_CODES.has(updateError.code));

        if (!shouldAlert) {
          // OWASP準拠のサニタイズは client 側（EmailChangeDialog.tsx）が汎用文言で行う。
          // ここでは生の GoTrue エラーを Sentry へ送らない — email 衝突等はユーザー起因の
          // 想定内失敗で、BAD_REQUEST は EXPECTED_TRPC_CODES に含まれるため
          // handleServiceError も自動報告しない
          throw new UserServiceError('EMAIL_UPDATE_FAILED', 'Email update failed', {
            cause: updateError,
          });
        }

        // alert 対象（#2064）。handleServiceError の自動報告には乗せない（あちらは
        // isExpectedAuthError のみでゲートされ、この allowlist を知らないため）。
        // REAUTH_UNAVAILABLE と同じ「呼び出し側の canary 1 本」パターンで、ここから
        // 直接 Sentry へ送る。updateError をラップせずそのまま渡す — observeAuthOperation
        // が先に同じ instance を capture 済みのケース（未知 code や 5xx）では
        // WeakSet dedup が効いて 1 本に収まる
        captureUnexpectedError(updateError, {
          feature: 'email_change',
          operation: 'update_email',
          source: 'supabase_auth',
        });
        throw new UserServiceError('EMAIL_UPDATE_UNAVAILABLE', 'Email update unavailable', {
          cause: updateError,
        });
      }

      return { success: true };
    },

    /**
     * 全ブロック（plans / records）を削除
     * タグ・設定・プロフィールは保持
     */
    async deleteBlocks(userId: string): Promise<{ deletedCount: number }> {
      const adminClient = createServiceRoleClient();
      let deletedCount = 0;

      // アカウント削除では記録と予定の両方を削除する。
      for (const table of [databaseTables.records, databaseTables.plans] as const) {
        const { data: deleted, error } = await adminClient
          .from(table)
          .delete()
          .eq('user_id', userId)
          .select('id');
        if (error) {
          const resource = table === databaseTables.records ? 'records' : table;
          const original = captureUnexpectedDatabaseError(error, {
            feature: 'account_data',
            operation: `delete_${resource}`,
          });
          throw new UserServiceError('DELETE_DATA_FAILED', `${resource} deletion failed`, {
            cause: original,
          });
        }
        deletedCount += deleted?.length ?? 0;
      }

      logger.info('Blocks deleted', { userId, count: deletedCount });
      return { deletedCount };
    },

    /**
     * 全データを削除（アカウントは保持）
     * plans, records, activities, categories, 設定を全削除
     */
    async deleteAllData(userId: string): Promise<{ success: true }> {
      const adminClient = createServiceRoleClient();
      // FK 依存順。service-role を使うが、全操作を認証済み userId で明示的に制限する。
      // activities は categories を参照するので先に消す。
      for (const table of [
        databaseTables.records,
        databaseTables.plans,
        databaseTables.activities,
        databaseTables.categories,
        databaseTables.userSettings,
      ] as const) {
        const { error } = await adminClient.from(table).delete().eq('user_id', userId);
        if (error) {
          const resource = table === databaseTables.records ? 'records' : table;
          const original = captureUnexpectedDatabaseError(error, {
            feature: 'account_data',
            operation: `delete_all_${resource}`,
          });
          throw new UserServiceError('DELETE_DATA_FAILED', `${resource} deletion failed`, {
            cause: original,
          });
        }
      }

      logger.info('All user data deleted (account preserved)', { userId });
      return { success: true };
    },

    /**
     * ユーザーデータエクスポート
     * GDPR "Right to Data Portability" 準拠
     */
    async exportData(options: ExportDataOptions): Promise<ExportDataResult> {
      const { userId } = options;

      const adminClient = createServiceRoleClient();
      const [
        profileResult,
        plansResult,
        recordsResult,
        categoriesResult,
        activitiesResult,
        userSettingsResult,
      ] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).single(),
        adminClient.from('plans').select(publicPlanSelect).eq('user_id', userId),
        adminClient.from(databaseTables.records).select(publicRecordSelect).eq('user_id', userId),
        supabase.from(databaseTables.categories).select('*').eq('user_id', userId),
        supabase.from(databaseTables.activities).select('*').eq('user_id', userId),
        supabase
          .from('user_settings')
          .select(publicUserSettingsSelect)
          .eq('user_id', userId)
          .single(),
      ]);

      if (profileResult.error && profileResult.error.code !== 'PGRST116') {
        const original = captureUnexpectedDatabaseError(profileResult.error, {
          feature: 'account_export',
          operation: 'fetch_profile',
        });
        throw new UserServiceError('EXPORT_FAILED', 'Profile fetch failed', { cause: original });
      }
      if (plansResult.error) {
        const original = captureUnexpectedDatabaseError(plansResult.error, {
          feature: 'account_export',
          operation: 'fetch_plans',
        });
        throw new UserServiceError('EXPORT_FAILED', 'Plans fetch failed', { cause: original });
      }
      if (recordsResult.error) {
        const original = captureUnexpectedDatabaseError(recordsResult.error, {
          feature: 'account_export',
          operation: 'fetch_records',
        });
        throw new UserServiceError('EXPORT_FAILED', 'Records fetch failed', { cause: original });
      }
      if (categoriesResult.error) {
        const original = captureUnexpectedDatabaseError(categoriesResult.error, {
          feature: 'account_export',
          operation: 'fetch_categories',
        });
        throw new UserServiceError('EXPORT_FAILED', 'Categories fetch failed', { cause: original });
      }
      if (activitiesResult.error) {
        const original = captureUnexpectedDatabaseError(activitiesResult.error, {
          feature: 'account_export',
          operation: 'fetch_activities',
        });
        throw new UserServiceError('EXPORT_FAILED', 'Activities fetch failed', { cause: original });
      }
      if (userSettingsResult.error && userSettingsResult.error.code !== 'PGRST116') {
        const original = captureUnexpectedDatabaseError(userSettingsResult.error, {
          feature: 'account_export',
          operation: 'fetch_user_settings',
        });
        throw new UserServiceError('EXPORT_FAILED', 'User settings fetch failed', {
          cause: original,
        });
      }
      return {
        exportedAt: new Date().toISOString(),
        userId,
        data: {
          profile: profileResult.data || null,
          plans: plansResult.data || [],
          records: recordsResult.data || [],
          categories: categoriesResult.data || [],
          activities: activitiesResult.data || [],
          userSettings: userSettingsResult.data || null,
        },
      };
    },
  };
}
