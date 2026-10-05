import 'server-only';

/**
 * MFA Recovery Codes
 *
 * MFAデバイス紛失時のアカウント復旧用リカバリーコード
 *
 * セキュリティ要件:
 * - 10個のワンタイムコードを生成
 * - 各コード：8文字の英数字（BASE32形式）
 * - SHA-256でハッシュ化して保存（平文は保存しない）
 * - 使用済みコードは削除
 *
 * @see OWASP - Account Recovery
 */

import { createHmac, randomInt, timingSafeEqual } from 'crypto';

import { env } from '@/env';

/**
 * リカバリーコードの設定
 */
const RECOVERY_CODE_CONFIG = {
  /** コードの数 */
  COUNT: 10,
  /** コードの長さ（ハイフン除く） */
  LENGTH: 8,
  /** コード形式：4文字-4文字 */
  FORMAT_LENGTH: 4,
} as const;

/**
 * HMAC pepper を取得
 * 環境変数から取得し、未設定の場合はフォールバック値を使用
 */
function getHmacPepper(): string {
  const pepper = env.RECOVERY_CODE_PEPPER ?? process.env.RECOVERY_CODE_PEPPER;
  if (!pepper) {
    throw new Error('RECOVERY_CODE_PEPPER is not set. Recovery codes require a pepper for HMAC.');
  }
  return pepper;
}

/**
 * リカバリーコードを生成
 * @returns 10個のリカバリーコード（フォーマット済み）
 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外（I,O,0,1）

  for (let i = 0; i < RECOVERY_CODE_CONFIG.COUNT; i++) {
    let code = '';

    for (let j = 0; j < RECOVERY_CODE_CONFIG.LENGTH; j++) {
      code += charset.charAt(randomInt(charset.length));
    }

    // フォーマット: XXXX-XXXX
    const formatted = `${code.slice(0, RECOVERY_CODE_CONFIG.FORMAT_LENGTH)}-${code.slice(RECOVERY_CODE_CONFIG.FORMAT_LENGTH)}`;
    codes.push(formatted);
  }

  return codes;
}

/**
 * リカバリーコードをハッシュ化
 * @param code リカバリーコード（ハイフンあり/なし）
 * @returns SHA-256ハッシュ
 */
export function hashRecoveryCode(code: string): string {
  // ハイフンと空白を除去して正規化
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  return createHmac('sha256', getHmacPepper()).update(normalized).digest('hex');
}

/**
 * リカバリーコードを検証
 * @param inputCode ユーザー入力のコード
 * @param hashedCode DBに保存されたハッシュ
 * @returns 一致するかどうか
 */
export function verifyRecoveryCode(inputCode: string, hashedCode: string): boolean {
  const inputHash = Buffer.from(hashRecoveryCode(inputCode), 'utf8');
  const storedHash = Buffer.from(hashedCode, 'utf8');
  // HMAC digestの比較はNodeのconstant-time primitiveに委ねる。
  // 不正な保存値で異長の場合は、primitiveがthrowする前に不一致へ倒す。
  // hexとしてdecodeしない（不正文字の切り捨て/大文字小文字の同一化を避ける）。
  return inputHash.length === storedHash.length && timingSafeEqual(inputHash, storedHash);
}

/**
 * リカバリーコードのフォーマットを検証
 * @param code 入力コード
 * @returns 有効なフォーマットかどうか
 */
export function isValidRecoveryCodeFormat(code: string): boolean {
  // ハイフンを除去して検証
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();

  // 8文字で、許可された文字のみ
  const validChars = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;
  return normalized.length === RECOVERY_CODE_CONFIG.LENGTH && validChars.test(normalized);
}

/**
 * リカバリーコードをDBに保存するための形式に変換
 * @param codes 生成されたリカバリーコード
 * @returns ハッシュ化されたコードの配列
 */
export function prepareCodesForStorage(codes: string[]): { hash: string; used: boolean }[] {
  return codes.map((code) => ({
    hash: hashRecoveryCode(code),
    used: false,
  }));
}
