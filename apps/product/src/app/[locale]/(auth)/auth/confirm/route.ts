/**
 * Email Confirmation Route Handler
 *
 * メールアドレス確認のコールバック処理
 *
 * フロー:
 * 1. ユーザーが確認メール内のリンクをクリック
 * 2. Supabaseがこのエンドポイントにリダイレクト（token_hash + type を付与）
 * 3. OTPトークンを検証してメールアドレスを確認
 * 4. session が確立できたら `next`（保護ページ）へ、できなければ結果ページへ着地する
 *
 * ## 検証成功 ≠ session あり（#1956）
 *
 * 以前は `verifyOtp` が成功したら無条件に `next` へ redirect していた。`next` は
 * `/settings/account` のような保護ページなので、session が無いと middleware が
 * `/auth/login?redirect=...` へ弾き、ユーザーには「確認できたのか、次に何をすべきか」が
 * 何も伝わらないまま login 画面が出る（2026-08-12 に production で観測）。
 *
 * session が立たない経路は email_change に限らない:
 *
 * - **email_change の 2 段確認** — `supabase/config.toml` の `double_confirm_changes = true`
 *   により新旧両方のリンクで完了する。片側だけの検証では変更が完了せず session も立たない
 * - **メールクライアントが開く browser** — アプリの session cookie を持たない文脈で
 *   リンクが開かれると、どの type でも session 無しで着地しうる
 *
 * そのため「session の有無」で分岐する。type ごとの特例にしないのは、無言バウンスが
 * type 固有の不具合ではなく `verifyOtp` 成功後に共通して起こりうる状態だから。
 *
 * ## 着地先が `/auth/confirmed` である理由
 *
 * login ページに案内を出す案は、**認証済みの browser で確認リンクを開いた場合に成立しない**。
 * `proxy.ts` は認証済みユーザーが auth 系 path に来ると `/calendar` へ送り、`/auth/login` は
 * `authPathsAllowedWhileAuthenticated`（`lib/auth/domain/access-policy.ts`）に無いため、
 * メッセージを表示する前に弾かれる。バウンス先が変わるだけで本件の混乱は残る。
 * `/auth/confirmed` は同 allowlist に登録してあり、認証済み・未認証のどちらでも表示できる。
 *
 * 失敗時も同じページへ送る。失敗の着地にも同じ「認証済みだと弾かれる」問題があるため、
 * 成功だけ直して失敗を login に残すと同じ穴が片側に残る。
 */

import type { EmailOtpType } from '@supabase/auth-js';
import { type NextRequest, NextResponse } from 'next/server';

import { deliverWelcomeEmailOnce } from '@/features/auth/server/welcome-email';
import { getSafeRedirectPath } from '@/lib/safe-redirect';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';

/** verifyOtp は Supabase Auth API 呼び出し 1 回のみ。redirect 前提の同期フローに余裕を見る。 */
export const maxDuration = 60;

/** 結果ページへ渡す status。値の集合は `auth/confirmed/page.tsx` と対で維持する。 */
function statusForType(type: EmailOtpType): string {
  return type === 'email_change' ? 'email_change_confirmed' : 'email_confirmed';
}

function confirmedUrl(status: string, request: NextRequest) {
  return new URL(`/auth/confirmed?status=${status}`, request.url);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = getSafeRedirectPath(searchParams.get('next'));

  if (tokenHash && type) {
    const supabase = await createClient();
    const { data, error } = await observeAuthOperation('verify_email_otp', () =>
      supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type,
      }),
    );

    if (!error) {
      // `access_token` の有無で判定するのは auth-js に合わせるため。auth-js は
      // `session?.access_token` がある時だけ `_saveSession` を呼ぶ（GoTrueClient）ので、
      // token を伴わない session オブジェクトでは cookie が書かれない。truthy 判定だと
      // その場合に保護ページへ送ってしまい、直したはずの無言バウンスが再現する。
      // 新規登録の確認だけを歓迎の合図にする。email_change / recovery は既存ユーザーの操作。
      // user を optional に読むのは、歓迎メールの都合で確認の着地を壊さないため。
      const signupUserId = type === 'signup' ? data.session?.user?.id : undefined;
      if (signupUserId) await deliverWelcomeEmailOnce(signupUserId);

      if (data.session?.access_token) {
        // recovery だけ next を無視して固定 path へ送る（#1928）。実際の発生原因は
        // production の Redirect URLs allowlist に `/auth/reset-password` が未登録で、
        // GoTrue が `redirect_to` を拒否して `next` が付かないまま fallback の `/calendar` へ
        // 落ちていたこと（allowlist は User が追加済み）。recovery の着地先は固定で問題
        // ないため、allowlist が再びドリフトしても壊れない形にしておく（防御層）。
        const target = type === 'recovery' ? '/auth/reset-password' : next;
        const destination = new URL(target, request.url);
        if (signupUserId) destination.searchParams.set('registered', 'email');
        return NextResponse.redirect(destination);
      }

      return NextResponse.redirect(confirmedUrl(statusForType(type), request));
    }
  }

  // トークンが無効または不足
  return NextResponse.redirect(confirmedUrl('failed', request));
}
