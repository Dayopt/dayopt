import { describe, expect, it } from 'vitest';

import { SESSION_CONFIG, SESSION_SECURITY } from './session-config';

describe('session-config', () => {
  describe('SESSION_CONFIG', () => {
    it('idleTimeoutが設定されている', () => {
      expect(SESSION_CONFIG.idleTimeout).toBeGreaterThan(0);
    });

    it('maxAgeが設定されている', () => {
      expect(SESSION_CONFIG.maxAge).toBeGreaterThan(0);
    });

    it('absoluteTimeoutが設定されている', () => {
      expect(SESSION_CONFIG.absoluteTimeout).toBeGreaterThan(0);
    });
  });

  describe('SESSION_SECURITY', () => {
    it('timeoutWarningが設定されている', () => {
      expect(SESSION_SECURITY.timeoutWarning).toBeGreaterThan(0);
    });

    it('logoutRedirectが設定されている', () => {
      expect(SESSION_SECURITY.logoutRedirect).toBe('/auth/login');
    });

    it('timeoutRedirectが設定されている', () => {
      expect(SESSION_SECURITY.timeoutRedirect).toContain('timeout');
    });
  });
});
