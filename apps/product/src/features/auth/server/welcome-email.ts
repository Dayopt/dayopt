import 'server-only';

import { getUserLocale, sendWelcomeEmail } from '@/lib/email/notifications';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/**
 * 新規登録の歓迎メールを 1 ユーザー 1 通だけ送る。
 *
 * サインアップ直後の着地点は 1 つではない（OAuth は `/auth/callback`、メール登録は
 * `/auth/confirm`、どちらもリロードで再実行されうる）。そこで「初回かどうか」をアプリ側で
 * 判定せず、`profiles.welcome_email_sent_at` の conditional UPDATE で DB に潰させる。
 * 掴めた 1 リクエストだけが送信する。
 *
 * **送る前に掴む**。順序を逆にすると、送信後の例外やリトライで二通目が飛ぶ。掴んだあとに
 * 送信が落ちた場合は歓迎メールが 1 通失われるが、二重送信より軽い失敗として受け入れる
 * （Sentry には残す）。
 *
 * この列は migration 時点の既存ユーザーを「送信済み」で埋めてあるので、過去のユーザーへ
 * 遡って送ることはない（20260916010000_track_welcome_email_sent.sql）。
 */
export async function deliverWelcomeEmailOnce(userId: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    const { data, error } = await supabase
      .from('profiles')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', userId)
      .is('welcome_email_sent_at', null)
      .select('id, full_name');

    if (error) {
      captureUnexpectedDatabaseError(error, {
        feature: 'auth',
        operation: 'claim_welcome_email',
      });
      return;
    }

    const claimed = data?.[0];
    // 掴めなかった = 既に送信済み。何もしないのが正常系。
    if (!claimed) return;

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.admin.getUserById(userId);

    if (authError || !user?.email) {
      logger.warn('Welcome email skipped: recipient address is unavailable');
      return;
    }

    await sendWelcomeEmail({
      email: user.email,
      userName: (claimed.full_name as string | null) || 'there',
      locale: await getUserLocale(supabase, userId),
    });
  } catch (error) {
    // サインインの完了をメール送信で妨げない。
    captureUnexpectedError(error instanceof Error ? error : new Error('Welcome email failed'), {
      feature: 'auth',
      operation: 'send_welcome_email',
    });
  }
}
