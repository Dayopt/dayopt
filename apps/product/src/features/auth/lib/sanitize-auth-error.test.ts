import { describe, expect, it } from 'vitest';

import { getAuthErrorKey } from '@/lib/auth-error';
import { RESOLVED_KEYS } from './sanitize-auth-error';

function err(message: string, code?: string) {
  return { message, code };
}

const ALL_CONTEXTS = ['login', 'signup', 'resetPassword', 'updatePassword', 'oauth'] as const;

describe('sanitize-auth-error', () => {
  describe('login', () => {
    it('一般的なエラーは全てinvalidCredentials（OWASP準拠）', () => {
      expect(getAuthErrorKey(err('Invalid login credentials'), 'login')).toBe(
        'auth.errors.invalidCredentials',
      );
      expect(getAuthErrorKey(err('User not found'), 'login')).toBe(
        'auth.errors.invalidCredentials',
      );
      expect(getAuthErrorKey(err('Wrong password'), 'login')).toBe(
        'auth.errors.invalidCredentials',
      );
      expect(getAuthErrorKey(err('Email not confirmed'), 'login')).toBe(
        'auth.errors.invalidCredentials',
      );
    });

    it('レート制限はaccountLockedを返す', () => {
      expect(getAuthErrorKey(err('Rate limit exceeded'), 'login')).toBe(
        'auth.errors.accountLocked',
      );
      expect(getAuthErrorKey(err('Too many requests'), 'login')).toBe('auth.errors.accountLocked');
    });

    it('captcha_failed は login context でも invalidCredentials に飲まれず captchaFailed を返す（#2031）', () => {
      expect(getAuthErrorKey(err('captcha protection failed', 'captcha_failed'), 'login')).toBe(
        'auth.errors.captchaFailed',
      );
    });
  });

  describe('signup', () => {
    it('既存ユーザーと未分類の失敗は同一の汎用キーに収束する（文言差自体がenumeration oracleになるのを防ぐ）', () => {
      const alreadyRegistered = getAuthErrorKey(err('User already registered'), 'signup');
      const alreadyExists = getAuthErrorKey(err('Email already exists'), 'signup');
      const duplicate = getAuthErrorKey(err('Duplicate key'), 'signup');
      const unknown = getAuthErrorKey(err('Unknown error'), 'signup');

      expect(alreadyRegistered).toBe('auth.errors.signupUnavailable');
      expect(alreadyExists).toBe('auth.errors.signupUnavailable');
      expect(duplicate).toBe('auth.errors.signupUnavailable');
      expect(unknown).toBe('auth.errors.signupUnavailable');
    });

    it('構造化codeを優先判定する（GoTrueのErrorCode、message変化に強い）', () => {
      expect(getAuthErrorKey(err('unrelated message', 'email_exists'), 'signup')).toBe(
        'auth.errors.signupUnavailable',
      );
      expect(getAuthErrorKey(err('unrelated message', 'user_already_exists'), 'signup')).toBe(
        'auth.errors.signupUnavailable',
      );
      expect(getAuthErrorKey(err('unrelated message', 'identity_already_exists'), 'signup')).toBe(
        'auth.errors.signupUnavailable',
      );
    });

    it('弱いパスワードはweakPassword', () => {
      expect(getAuthErrorKey(err('Password is too weak'), 'signup')).toBe(
        'auth.errors.weakPassword',
      );
    });

    it('レート制限はtooManyRequests', () => {
      expect(getAuthErrorKey(err('Rate limit exceeded'), 'signup')).toBe(
        'auth.errors.tooManyRequests',
      );
    });

    it('captcha_failed は signup context でも captchaFailed を返す（#2031）', () => {
      expect(
        getAuthErrorKey(
          err('captcha protection: invalid-input-secret', 'captcha_failed'),
          'signup',
        ),
      ).toBe('auth.errors.captchaFailed');
    });
  });

  describe('updatePassword', () => {
    it('弱いパスワードはweakPassword', () => {
      expect(getAuthErrorKey(err('Password too weak'), 'updatePassword')).toBe(
        'auth.errors.weakPassword',
      );
      expect(getAuthErrorKey(err('Password too short'), 'updatePassword')).toBe(
        'auth.errors.weakPassword',
      );
    });

    it('その他は汎用エラー', () => {
      expect(getAuthErrorKey(err('Unknown'), 'updatePassword')).toBe('auth.errors.unexpectedError');
    });
  });

  describe('oauth / resetPassword', () => {
    it('常に汎用エラー', () => {
      expect(getAuthErrorKey(err('Any error'), 'oauth')).toBe('auth.errors.unexpectedError');
      expect(getAuthErrorKey(err('Any error'), 'resetPassword')).toBe(
        'auth.errors.unexpectedError',
      );
    });

    it('captcha_failed は resetPassword context でも captchaFailed を返す（#2031）', () => {
      expect(getAuthErrorKey(err('any message', 'captcha_failed'), 'resetPassword')).toBe(
        'auth.errors.captchaFailed',
      );
    });
  });

  describe('RESOLVED_KEYS の二重解決耐性', () => {
    // useAuthStore の catch 経路（resolveAuthErrorKey）は解決済みキーを message に詰めて
    // 返す。呼び出し元コンポーネントがこれを再度 getAuthErrorKey に通しても、
    // 同じキーがそのまま返らなければならない（auth-error.ts の RESOLVED_KEYS コメント参照）。
    //
    // RESOLVED_KEYS の判定は message 一致のみで context を見ないため（auth-error.ts の
    // 実装上、context分岐より前でreturnする）、この不変条件は「どの key」×「どの context」
    // の組み合わせでも成り立たなければならない。手書きの個別列挙だとキー追加時に
    // テストが追従し忘れて漏れるため、RESOLVED_KEYS 自体を it.each で総当たりする
    it.each(RESOLVED_KEYS.flatMap((key) => ALL_CONTEXTS.map((context) => [key, context] as const)))(
      '%s は context=%s で再投入しても自身を返す',
      (key, context) => {
        expect(getAuthErrorKey(err(key), context)).toBe(key);
      },
    );
  });
});
