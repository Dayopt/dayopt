import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  register: vi.fn(),
  register_once: vi.fn(),
}));

vi.mock('posthog-js', () => ({ default: sdk }));

import {
  capturePostHogBrowserEvent,
  identifyPostHogBrowser,
  startPostHogBrowser,
  stopPostHogBrowser,
} from './posthog-browser';

describe('PostHog browser consent boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPostHogBrowser();
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
    await startPostHogBrowser(options);
    expect(sdk.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
      }),
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
      properties: { $current_url: 'https://dayopt.app/ja', environment: 'preview' },
    });
    expect(config.before_send({ event: '$autocapture', properties: {} })).toBeNull();

    capturePostHogBrowserEvent('signup_cta_clicked');
    identifyPostHogBrowser('00000000-0000-4000-8000-000000000001');
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.identify).toHaveBeenCalledOnce();

    allowed = false;
    expect(config.before_send({ event: '$pageview', properties: {} })).toBeNull();
    capturePostHogBrowserEvent('signup_cta_clicked');
    identifyPostHogBrowser('00000000-0000-4000-8000-000000000001');
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.identify).toHaveBeenCalledOnce();
  });
});
