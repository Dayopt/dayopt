import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopPostHogBrowser } from './posthog-browser';

describe('PostHog browser persistence cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('expires the project cookie on this host and the shared Dayopt domain without an SDK client', () => {
    const cookieWrites: string[] = [];
    const removeItem = vi.fn();
    const documentStub = {};
    Object.defineProperty(documentStub, 'cookie', {
      set: (value: string) => cookieWrites.push(value),
    });
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', {
      location: { protocol: 'https:' },
      sessionStorage: { removeItem },
    });

    stopPostHogBrowser('phc_test');

    expect(cookieWrites).toContain(
      'ph_phc_test_posthog=; Max-Age=0; Path=/; SameSite=Lax; Secure; Domain=.dayopt.app',
    );
    expect(cookieWrites).toContain('ph_phc_test_posthog=; Max-Age=0; Path=/; SameSite=Lax; Secure');
    expect(removeItem).toHaveBeenCalledWith('ph_phc_test_posthog');
    expect(removeItem).toHaveBeenCalledWith('ph_phc_test_session_registered_properties');
  });
});
