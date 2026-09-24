import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  clear_opt_in_out_capturing: vi.fn(),
  persistence: { clear: vi.fn(), set_disabled: vi.fn() },
  sessionPersistence: { clear: vi.fn(), set_disabled: vi.fn() },
  register: vi.fn(),
  register_once: vi.fn(),
}));

vi.mock('posthog-js', () => ({ default: sdk }));

import {
  capturePostHogBrowserEvent,
  identifyPostHogBrowser,
  resetPostHogBrowserIdentity,
  startPostHogBrowser,
  stopPostHogBrowser,
} from './posthog-browser';

describe('PostHog browser consent boundary', () => {
  beforeEach(() => {
    stopPostHogBrowser();
    vi.clearAllMocks();
    sdk.init.mockImplementation(() => undefined);
    vi.stubGlobal('window', { location: { origin: 'https://dayopt.app' } });
  });

  it('does not load or emit events without consent, and strips SDK properties before sending', async () => {
    let allowed = false;
    const options = {
      projectKey: 'phc_test',
      environment: 'preview' as const,
      surface: 'web' as const,
      hasConsent: () => allowed,
    };

    await startPostHogBrowser(options);
    expect(sdk.init).not.toHaveBeenCalled();
    allowed = true;
    const startup = startPostHogBrowser(options);
    capturePostHogBrowserEvent('signup_viewed', { screen: 'signup' });
    await startup;
    expect(sdk.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
      }),
    );
    expect(sdk.capture).toHaveBeenCalledWith(
      'signup_viewed',
      expect.objectContaining({ screen: 'signup' }),
      undefined,
    );

    const config = sdk.init.mock.calls[0]?.[1];
    expect(
      config.before_send({
        event: '$pageview',
        properties: {
          $current_url: 'https://dayopt.app/ja/?email=secret@example.com',
          email: 'secret@example.com',
          environment: 'preview',
        },
        $set: { email: 'secret@example.com' },
      }),
    ).toEqual({
      event: '$pageview',
      properties: {
        $current_url: 'https://dayopt.app/ja',
        environment: 'preview',
        $geoip_disable: true,
      },
    });
    expect(config.before_send({ event: '$autocapture', properties: {} })).toBeNull();

    capturePostHogBrowserEvent('signup_cta_clicked');
    identifyPostHogBrowser('00000000-0000-4000-8000-000000000001');
    resetPostHogBrowserIdentity();
    expect(sdk.capture).toHaveBeenCalledTimes(2);
    expect(sdk.capture).toHaveBeenCalledWith('signup_cta_clicked', expect.any(Object), {
      send_instantly: true,
      transport: 'sendBeacon',
    });
    expect(sdk.identify).toHaveBeenCalledOnce();
    expect(sdk.reset).toHaveBeenCalledOnce();

    stopPostHogBrowser();
    expect(sdk.opt_out_capturing).toHaveBeenCalledOnce();
    expect(sdk.persistence.clear).toHaveBeenCalledOnce();
    expect(sdk.sessionPersistence.clear).toHaveBeenCalledOnce();
    expect(sdk.persistence.set_disabled).toHaveBeenLastCalledWith(true);

    allowed = false;
    expect(config.before_send({ event: '$pageview', properties: {} })).toBeNull();
    capturePostHogBrowserEvent('signup_cta_clicked');
    identifyPostHogBrowser('00000000-0000-4000-8000-000000000001');
    expect(sdk.capture).toHaveBeenCalledTimes(2);
    expect(sdk.identify).toHaveBeenCalledOnce();
    expect(sdk.reset).toHaveBeenCalledOnce();
  });
});
