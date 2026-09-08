/**
 * テスト専用の TOTP 生成（RFC 6238、SHA-1 / 30 秒 / 6 桁）。
 *
 * integration test で TOTP factor を enroll → verify し、実際に aal2 のセッションを
 * 作るために使う。production コードからは参照しない。
 */

import { createHmac } from 'node:crypto';

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** base32 secret から現在時刻の TOTP を作る */
export function generateTotp(base32Secret: string, forTime: number = Date.now()): string {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(forTime / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binCode % 1_000_000).padStart(6, '0');
}
