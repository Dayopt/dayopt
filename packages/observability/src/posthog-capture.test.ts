import { describe, expect, it } from 'vitest';

import {
  filterPostHogBrowserProperties,
  postHogExternalReferrer,
  postHogPageLanguage,
  postHogPagePath,
  postHogUtm,
} from './posthog-capture';

describe('PostHog browser data boundary', () => {
  it('keeps only a safe page path and permitted UTM', () => {
    expect(postHogPagePath('/ja/blog/hello-world')).toBe('/ja/blog/hello-world');
    expect(postHogPageLanguage('/ja/blog/hello-world')).toBe('ja');
    expect(postHogPageLanguage('/en/blog/hello-world')).toBe('en');
    expect(postHogPagePath('/ja/user/09f7106708384e9fa05dd729bc876281')).toBe('/ja/user/:page');
    expect(postHogUtm(' Newsletter_One ')).toBe('newsletter_one');
    expect(postHogUtm('person@example.com')).toBeUndefined();
    expect(postHogUtm('a'.repeat(65))).toBeUndefined();
  });

  it('retains only external referring domain', () => {
    expect(postHogExternalReferrer('https://news.example.com/path?email=a@example.com')).toBe(
      'news.example.com',
    );
    expect(postHogExternalReferrer('https://app.dayopt.app/calendar')).toBeUndefined();
  });

  it('drops SDK-added URL queries, person data, and unknown events', () => {
    expect(
      filterPostHogBrowserProperties(
        '$pageview',
        {
          token: 'phc_test',
          distinct_id: 'visitor-1',
          $current_url: 'https://dayopt.app/ja/blog/post?email=a%40example.com',
          $referrer: 'https://news.example.com/article?secret=123',
          $utm_source: ' Newsletter ',
          $insert_id: '0123456789abcdef0123456789abcdef',
          email: 'a@example.com',
          $geoip_city_name: 'Tokyo',
          $session_recording_enabled: true,
        },
        'https://dayopt.app',
      ),
    ).toEqual({
      token: 'phc_test',
      distinct_id: 'visitor-1',
      $current_url: 'https://dayopt.app/ja/blog/post',
      $referrer: 'https://news.example.com/',
      $utm_source: 'newsletter',
      $insert_id: '0123456789abcdef0123456789abcdef',
      $geoip_disable: true,
    });
    expect(filterPostHogBrowserProperties('$autocapture', {}, 'https://dayopt.app')).toBeNull();
  });

  it('fails closed on an unexpected current URL', () => {
    expect(
      filterPostHogBrowserProperties(
        '$pageview',
        { $current_url: 'https://attacker.example/secret' },
        'https://dayopt.app',
      ),
    ).toBeNull();
  });

  it('rejects untrusted values in fixed browser event properties', () => {
    expect(
      filterPostHogBrowserProperties(
        'signup_viewed',
        {
          screen: 'private note',
          cta_id: 'account-123',
          environment: 'production',
          surface: 'product',
          schema_version: 1,
        },
        'https://app.dayopt.app',
      ),
    ).toEqual({
      environment: 'production',
      surface: 'product',
      schema_version: 1,
      $geoip_disable: true,
    });
  });
});
