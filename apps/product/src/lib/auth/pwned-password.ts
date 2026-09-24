import { logger } from '@/lib/logger';

/**
 * Have I Been Pwned API統合 - 漏洩パスワードチェック
 *
 * NIST & OWASP推奨: 既知の漏洩パスワードの使用を防止
 *
 * k-Anonymity モデル:
 * - SHA-1ハッシュの最初の5文字のみ送信
 * - APIに完全なパスワードやハッシュを送信しない（プライバシー保護）
 *
 * 採用企業: 1Password, Firefox/Mozilla, Microsoft, Cloudflare
 *
 * @see https://haveibeenpwned.com/API/v3
 * @module pwned-password
 */

/**
 * HIBP への 1 リクエストの上限。応答しない接続（キャプティブポータル、
 * パケットを捨てる proxy）でサインアップのスピナーが止まらなくなるのを防ぐ。
 * 超過時は catch が fail-open で false / 0 を返し、登録自体は続行できる。
 */
export const PWNED_PASSWORD_TIMEOUT_MS = 3_000;

/**
 * SHA-1ハッシュを計算（Web Crypto API使用）
 */
async function sha1(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Have I Been Pwned APIで漏洩パスワードをチェック
 *
 * k-Anonymity モデル実装:
 * 1. パスワードをSHA-1ハッシュ化
 * 2. 最初の5文字をAPIに送信
 * 3. APIが同じプレフィックスを持つハッシュを返す（平均477件）
 * 4. クライアントでローカル照合
 *
 * @param password - チェックするパスワード（平文）
 * @returns 漏洩している場合はtrue、安全な場合はfalse
 *
 * @example
 * ```typescript
 * const isPwned = await checkPasswordPwned('password123')
 * if (isPwned) {
 *   throw new Error('このパスワードは過去に漏洩しています')
 * }
 * ```
 */
export async function checkPasswordPwned(password: string): Promise<boolean> {
  try {
    // ステップ1: SHA-1ハッシュ化
    const hash = await sha1(password);

    // ステップ2: 最初の5文字とそれ以降に分割
    const prefix = hash.substring(0, 5);
    const suffix = hash.substring(5);

    // ステップ3: Have I Been Pwned API呼び出し（k-Anonymity）
    const apiUrl = `https://api.pwnedpasswords.com/range/${prefix}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Dayopt-App', // API推奨のUser-Agent
      },
      signal: AbortSignal.timeout(PWNED_PASSWORD_TIMEOUT_MS),
    });

    if (!response.ok) {
      // APIエラー時は安全側に倒す（チェックをスキップ）
      logger.warn(`Pwned Passwords API error: ${response.status}`);
      return false;
    }

    // ステップ4: レスポンス解析
    const text = await response.text();

    // レスポンス形式: "HASH_SUFFIX:COUNT\r\n" の繰り返し
    // 例: "003D68EB55068C33ACE09247EE4C639306B:3\r\n"
    const lines = text.split('\r\n');

    for (const line of lines) {
      const [hashSuffix] = line.split(':');
      if (hashSuffix === suffix) {
        // 漏洩パスワードと一致
        return true;
      }
    }

    // どれとも一致しない（安全）
    return false;
  } catch (err) {
    // ネットワークエラー等の場合は安全側に倒す
    logger.error('Pwned password check error:', err);
    return false;
  }
}

/**
 * 漏洩回数を取得（オプション機能）
 *
 * @param password - チェックするパスワード（平文）
 * @returns 漏洩回数（0の場合は安全）
 */
export async function getPasswordPwnedCount(password: string): Promise<number> {
  try {
    const hash = await sha1(password);
    const prefix = hash.substring(0, 5);
    const suffix = hash.substring(5);

    const apiUrl = `https://api.pwnedpasswords.com/range/${prefix}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Dayopt-App',
      },
      signal: AbortSignal.timeout(PWNED_PASSWORD_TIMEOUT_MS),
    });

    if (!response.ok) {
      return 0;
    }

    const text = await response.text();
    const lines = text.split('\r\n');

    for (const line of lines) {
      const [hashSuffix, count] = line.split(':');
      if (hashSuffix === suffix && count) {
        return parseInt(count, 10);
      }
    }

    return 0;
  } catch (err) {
    logger.error('Pwned password count check error:', err);
    return 0;
  }
}
