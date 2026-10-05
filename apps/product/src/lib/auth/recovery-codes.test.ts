/**
 * Recovery Codes Unit Tests
 *
 * MFAリカバリーコード機能のユニットテスト
 * セキュリティ要件の検証を含む
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  isValidRecoveryCodeFormat,
  prepareCodesForStorage,
  verifyRecoveryCode,
} from './recovery-codes';

// CI環境で RECOVERY_CODE_PEPPER が未設定の場合のフォールバック
beforeAll(() => {
  if (!process.env.RECOVERY_CODE_PEPPER) {
    process.env.RECOVERY_CODE_PEPPER = 'test-pepper-for-ci';
  }
});

describe('Recovery Codes', () => {
  describe('generateRecoveryCodes', () => {
    it('should generate 10 recovery codes', () => {
      const codes = generateRecoveryCodes();

      expect(codes).toHaveLength(10);
    });

    it('should generate codes in XXXX-XXXX format', () => {
      const codes = generateRecoveryCodes();

      codes.forEach((code) => {
        expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      });
    });

    it('should not include confusing characters (I, O, 0, 1)', () => {
      const codes = generateRecoveryCodes();
      const confusingChars = /[IO01]/;

      codes.forEach((code) => {
        expect(confusingChars.test(code)).toBe(false);
      });
    });

    it('should generate unique codes', () => {
      const codes = generateRecoveryCodes();
      const uniqueCodes = new Set(codes);

      expect(uniqueCodes.size).toBe(codes.length);
    });

    it('should generate different codes on each call', () => {
      const codes1 = generateRecoveryCodes();
      const codes2 = generateRecoveryCodes();

      // すべてのコードが同じになる確率は極めて低い
      const allSame = codes1.every((code, i) => code === codes2[i]);
      expect(allSame).toBe(false);
    });

    it('should only use allowed charset', () => {
      const codes = generateRecoveryCodes();
      const allowedChars = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789-]+$/;

      codes.forEach((code) => {
        expect(allowedChars.test(code)).toBe(true);
      });
    });
  });

  describe('hashRecoveryCode', () => {
    it('should produce SHA-256 hash (64 hex characters)', () => {
      const hash = hashRecoveryCode('ABCD-EFGH');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should normalize input (remove hyphens and spaces)', () => {
      const hash1 = hashRecoveryCode('ABCD-EFGH');
      const hash2 = hashRecoveryCode('ABCDEFGH');
      const hash3 = hashRecoveryCode('ABCD EFGH');

      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
    });

    it('should be case-insensitive', () => {
      const hash1 = hashRecoveryCode('ABCD-EFGH');
      const hash2 = hashRecoveryCode('abcd-efgh');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different codes', () => {
      const hash1 = hashRecoveryCode('ABCD-EFGH');
      const hash2 = hashRecoveryCode('WXYZ-1234');

      expect(hash1).not.toBe(hash2);
    });

    it('should be deterministic', () => {
      const hash1 = hashRecoveryCode('TEST-CODE');
      const hash2 = hashRecoveryCode('TEST-CODE');

      expect(hash1).toBe(hash2);
    });
  });

  describe('verifyRecoveryCode', () => {
    it('should return true for matching code', () => {
      const code = 'ABCD-EFGH';
      const hash = hashRecoveryCode(code);

      const isValid = verifyRecoveryCode(code, hash);

      expect(isValid).toBe(true);
    });

    it('should return false for non-matching code', () => {
      const hash = hashRecoveryCode('ABCD-EFGH');

      const isValid = verifyRecoveryCode('WXYZ-1234', hash);

      expect(isValid).toBe(false);
    });

    it('should handle lowercase input', () => {
      const code = 'ABCD-EFGH';
      const hash = hashRecoveryCode(code);

      const isValid = verifyRecoveryCode('abcd-efgh', hash);

      expect(isValid).toBe(true);
    });

    it('should handle input without hyphens', () => {
      const code = 'ABCD-EFGH';
      const hash = hashRecoveryCode(code);

      const isValid = verifyRecoveryCode('ABCDEFGH', hash);

      expect(isValid).toBe(true);
    });

    it('should handle input with spaces', () => {
      const code = 'ABCD-EFGH';
      const hash = hashRecoveryCode(code);

      const isValid = verifyRecoveryCode('ABCD EFGH', hash);

      expect(isValid).toBe(true);
    });
  });

  describe('isValidRecoveryCodeFormat', () => {
    it('should accept valid format with hyphen', () => {
      expect(isValidRecoveryCodeFormat('ABCD-EFGH')).toBe(true);
    });

    it('should accept valid format without hyphen', () => {
      expect(isValidRecoveryCodeFormat('ABCDEFGH')).toBe(true);
    });

    it('should accept lowercase input', () => {
      expect(isValidRecoveryCodeFormat('abcd-efgh')).toBe(true);
    });

    it('should accept mixed case input', () => {
      expect(isValidRecoveryCodeFormat('AbCd-EfGh')).toBe(true);
    });

    it('should reject codes with invalid characters', () => {
      // I, O, 0, 1は使用不可
      expect(isValidRecoveryCodeFormat('ABCD-EFGI')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABCD-EFGO')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABCD-EFG0')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABCD-EFG1')).toBe(false);
    });

    it('should reject codes that are too short', () => {
      expect(isValidRecoveryCodeFormat('ABCD-EFG')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABC')).toBe(false);
    });

    it('should reject codes that are too long', () => {
      expect(isValidRecoveryCodeFormat('ABCD-EFGHI')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABCDEFGHIJ')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidRecoveryCodeFormat('')).toBe(false);
    });

    it('should reject special characters', () => {
      expect(isValidRecoveryCodeFormat('ABCD!EFG')).toBe(false);
      expect(isValidRecoveryCodeFormat('ABCD@EFG')).toBe(false);
    });
  });

  describe('prepareCodesForStorage', () => {
    it('should convert codes to storage format', () => {
      const codes = ['ABCD-EFGH', 'WXYZ-2345'];
      const prepared = prepareCodesForStorage(codes);

      expect(prepared).toHaveLength(2);
      prepared.forEach((item) => {
        expect(item).toHaveProperty('hash');
        expect(item).toHaveProperty('used');
        expect(item.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(item.used).toBe(false);
      });
    });

    it('should hash each code correctly', () => {
      const codes = ['ABCD-EFGH'];
      const prepared = prepareCodesForStorage(codes);

      const expectedHash = hashRecoveryCode('ABCD-EFGH');
      expect(prepared[0]?.hash).toBe(expectedHash);
    });

    it('should mark all codes as unused', () => {
      const codes = generateRecoveryCodes();
      const prepared = prepareCodesForStorage(codes);

      prepared.forEach((item) => {
        expect(item.used).toBe(false);
      });
    });

    it('should handle empty array', () => {
      const prepared = prepareCodesForStorage([]);

      expect(prepared).toHaveLength(0);
    });
  });

  describe('Integration: Generate, Store, Verify', () => {
    it('should work end-to-end', () => {
      // 1. コード生成
      const codes = generateRecoveryCodes();
      expect(codes).toHaveLength(10);

      // 2. ストレージ用に変換
      const storedCodes = prepareCodesForStorage(codes);
      expect(storedCodes).toHaveLength(10);

      // 3. 各コードが検証可能
      codes.forEach((code, index) => {
        const hash = storedCodes[index]?.hash;
        if (!hash) return;
        const isValid = verifyRecoveryCode(code, hash);
        expect(isValid).toBe(true);
      });
    });

    it('should fail verification for wrong code against any stored hash', () => {
      const codes = generateRecoveryCodes();
      const storedCodes = prepareCodesForStorage(codes);
      const wrongCode = 'ZZZZ-ZZZZ';

      storedCodes.forEach((stored) => {
        const isValid = verifyRecoveryCode(wrongCode, stored.hash);
        expect(isValid).toBe(false);
      });
    });
  });

  describe('Security Properties', () => {
    // 平均時間差の比率を測ってもconstant-timeの保証にはならない。
    // ここでは文字列比較の契約を検査し、constant-time比較はNodeのprimitiveへ委ねる。
    it.each([0, 31, 63])('保存hashの位置%dだけが違う場合も拒否する', (position) => {
      const code = 'ABCD-EFGH';
      const hash = hashRecoveryCode(code);
      const different = `${hash.slice(0, position)}${hash[position] === '0' ? '1' : '0'}${hash.slice(position + 1)}`;
      expect(verifyRecoveryCode(code, different)).toBe(false);
    });

    it.each(['', 'short', 'a'.repeat(65), 'あ'.repeat(64)])(
      '不正な保存hashを例外ではなく不一致として扱う: %s',
      (storedHash) => {
        expect(verifyRecoveryCode('ABCD-EFGH', storedHash)).toBe(false);
      },
    );

    it('should not store plain text codes', () => {
      const codes = generateRecoveryCodes();
      const stored = prepareCodesForStorage(codes);

      // ストレージ形式にプレーンテキストが含まれていないことを確認
      stored.forEach((item, index) => {
        expect(item.hash).not.toBe(codes[index]);
        expect(item.hash).not.toContain('-');
      });
    });
  });
});
