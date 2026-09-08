/**
 * 認証メールに載せる確認 URL の組み立て（#2616）。
 *
 * **なぜ index.ts から分離したか**: `index.ts` は module scope で `Deno.env.get` を呼ぶため
 * Node 側の test runner から import できない。ここは Deno API に一切触れない純関数だけを置き、
 * `scripts/__tests__/send-auth-email-confirm-url.test.ts` から直接検証する。
 */

import type { EmailData } from '../_shared/types.ts';

/**
 * `token_hash` を載せてよい origin の allowlist。
 *
 * **これは GoTrue の redirect allowlist の代替ではなく、二重化**（#2616）。確認・リセット・
 * メール変更のリンクは `token_hash` を含むので、配送先 origin は「GoTrue が uri_allow_list を
 * 正しく設定し続けている」という前提だけに依存させない。production の allowlist は Dashboard が
 * 正本で repo からは強制できず、`scripts/ci/production-auth-config-audit.mjs` の判定も
 * fail-open（監査が読めなければ通る）である以上、設定 drift だけで token の配送先が第三者へ
 * 広がる経路を残さない。
 *
 * **現状の幅は GoTrue 側と同じ**にしてある。`product-*-dayopt.vercel.app` を狭められるかは
 * 「第三者が `-dayopt` で終わる Vercel team slug を取得できるか」の実測待ちで、その結論は
 * #2616 手順 1 に残っている。ここを狭めるのは実測後（狭めすぎると Preview の認証メールが
 * 本番 origin へ落ちてリンクが機能しなくなる）。
 */
const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https:\/\/app\.dayopt\.app$/,
  /^https:\/\/product-dayopt\.vercel\.app$/,
  // Vercel preview（`product-<hash>-dayopt.vercel.app` / `product-git-<branch>-dayopt.vercel.app`）。
  // `[a-z0-9-]+` はドットを含まないので、`product-x.evil-dayopt.vercel.app` のような
  // 別ホストへの拡張は一致しない。
  /^https:\/\/product-[a-z0-9-]+-dayopt\.vercel\.app$/,
];

/**
 * `redirect_to` の origin を採用してよいか判定し、駄目なら `appUrl` の origin へ落とす。
 *
 * `appUrl`（`NEXT_PUBLIC_APP_URL`。環境ごとに設定される Edge Function secret）は常に許可する。
 * Preview branch では `appUrl` 自身が preview URL になるため、この 1 本で環境差を吸収する。
 */
export function resolveConfirmOrigin(redirectTo: string | undefined, appUrl: string): string {
  if (!redirectTo) return appUrl;

  let candidate: string;
  try {
    candidate = new URL(redirectTo).origin;
  } catch {
    // redirect_to が不正なら appUrl の既定挙動にフォールバック
    return appUrl;
  }

  let appOrigin: string;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    appOrigin = appUrl;
  }
  if (candidate === appOrigin) return candidate;

  if (ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(candidate))) return candidate;

  return appOrigin;
}

/**
 * Auth メールタイプに応じた確認 URL を構築する。
 *
 * token_hash を検証できるのはアプリの `/auth/confirm` route（verifyOtp）だけなので、
 * リンクは必ず confirm route を経由させ、検証後の行き先を `next` で渡す。
 * redirect_to に直接 token_hash を付けると着地先が検証せずリンクが死ぬ（過去バグ）。
 *
 * - host: `redirect_to` の origin を allowlist 検証してから採用する（#2616）
 * - next: `redirect_to` の path + query。**origin が拒否されても `next` はそのまま渡す** —
 *   着地先での検証は app 側の `getSafeRedirectPath` が行っており、ここを変えると
 *   上記の「リンクが死ぬ」過去バグを再発させる
 */
export function buildConfirmUrl(params: {
  emailData: EmailData;
  appUrl: string;
  /** email_change では宛先ごとに使う hash が異なるため上書き可能にする */
  tokenHash?: string;
}): string {
  const { emailData, appUrl } = params;
  const { redirect_to, email_action_type } = emailData;
  const tokenHash = params.tokenHash ?? emailData.token_hash;

  const origin = resolveConfirmOrigin(redirect_to, appUrl);

  let nextPath = '';
  if (redirect_to) {
    try {
      const redirectUrl = new URL(redirect_to);
      nextPath = `${redirectUrl.pathname}${redirectUrl.search}`;
    } catch {
      nextPath = '';
    }
  }

  const url = new URL('/auth/confirm', origin);
  url.searchParams.set('token_hash', tokenHash);
  // verifyOtp の EmailOtpType は 'magiclink'（アンダースコアなし）
  url.searchParams.set(
    'type',
    email_action_type === 'magic_link' ? 'magiclink' : email_action_type,
  );
  if (nextPath && nextPath !== '/') {
    url.searchParams.set('next', nextPath);
  }
  return url.toString();
}
