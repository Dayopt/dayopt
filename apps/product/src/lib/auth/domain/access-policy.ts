const protectedProductPaths = [
  '/calendar',
  '/report',
  '/settings',
  '/oauth/authorize',
  '/oauth/consent',
] as const;

const authProductPaths = ['/login', '/signup', '/auth'] as const;

/**
 * 認証済みでもアクセスを許す auth path。
 *
 * 通常の auth path（ログイン・サインアップ）は認証済みなら /calendar へ流すが、
 * 以下はセッションを持ったまま踏むのが正常系なので除外する:
 * - `/auth/mfa-verify`: aal1 セッションから aal2 へ昇格させる
 * - `/auth/confirm`: メール内リンクの token_hash を verifyOtp する。ログイン中の
 *   メールアドレス変更はここを必ず通る
 * - `/auth/callback`: OAuth の code 交換
 * - `/auth/reset-password`: confirm の verifyOtp でセッション確立後に着地する
 * - `/auth/session-error`: MFA AAL lookup 失敗時の着地ページ（#2144）。認証済みで
 *   弾くと `/calendar` との無限 redirect ループになる（proxy.ts の lookupFailed 分岐参照）
 */
const authPathsAllowedWhileAuthenticated = [
  '/auth/mfa-verify',
  '/auth/confirm',
  // メール確認の結果ページ（#1956）。確認リンクはログイン中の browser でも開かれるため、
  // 認証済みで弾くと「確認できたのか分からないまま /week へ飛ぶ」無言バウンスになる。
  '/auth/confirmed',
  '/auth/callback',
  '/auth/reset-password',
  '/auth/session-error',
] as const;

const publicProductPaths = ['/', '/about', '/privacy', '/terms', '/contact', '/pricing'] as const;

const publicRewritePaths = ['/mcp', '/oauth/token'] as const;

export function isProtectedProductPath(pathname: string): boolean {
  return matchesPathPrefix(pathname, protectedProductPaths);
}

export function isAuthProductPath(pathname: string): boolean {
  return matchesPathPrefix(pathname, authProductPaths);
}

/** 認証済みユーザーを /week へ流してはいけない auth path かどうか */
export function isAuthPathAllowedWhileAuthenticated(pathname: string): boolean {
  return matchesExactPath(pathname, authPathsAllowedWhileAuthenticated);
}

export function isPublicProductPath(pathname: string): boolean {
  return matchesExactPath(pathname, publicProductPaths);
}

export function isPublicRewritePath(pathname: string): boolean {
  return matchesExactPath(pathname, publicRewritePaths);
}

function matchesPathPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((path) => pathname.startsWith(path));
}

function matchesExactPath(pathname: string, paths: readonly string[]): boolean {
  return paths.some((path) => pathname === path);
}
