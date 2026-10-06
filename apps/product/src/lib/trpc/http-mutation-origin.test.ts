import { describe, expect, it } from 'vitest';

import { rejectCrossOriginMutation } from './http-mutation-origin';

const appUrl = 'https://app.dayopt.app/api/trpc/userSettings.update';

function request(method: string, headers: HeadersInit = {}) {
  return new Request(appUrl, { method, headers });
}

describe('tRPC HTTP mutation origin boundary', () => {
  it('allows a same-origin browser mutation', () => {
    expect(
      rejectCrossOriginMutation(request('POST', { origin: 'https://app.dayopt.app' })),
    ).toBeNull();
  });

  it.each(['http://localhost:3001', 'https://evil.example', 'null', 'invalid origin'])(
    'rejects a POST from origin %s before parsing its content type',
    async (origin) => {
      const response = rejectCrossOriginMutation(request('POST', { origin }));

      expect(response?.status).toBe(403);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      await expect(response?.text()).resolves.toBe('Forbidden');
    },
  );

  it('uses Referer when Origin is absent and rejects a cross-origin browser mutation', () => {
    const response = rejectCrossOriginMutation(
      request('POST', { referer: 'https://evil.example/attack' }),
    );

    expect(response?.status).toBe(403);
  });

  it('allows a same-origin Referer fallback', () => {
    expect(
      rejectCrossOriginMutation(request('POST', { referer: 'https://app.dayopt.app/settings' })),
    ).toBeNull();
  });

  it('allows origin-less non-browser mutations for existing tRPC clients', () => {
    expect(rejectCrossOriginMutation(request('POST'))).toBeNull();
  });

  it('does not treat safe methods as mutations', () => {
    expect(
      rejectCrossOriginMutation(request('GET', { origin: 'https://evil.example' })),
    ).toBeNull();
    expect(
      rejectCrossOriginMutation(request('OPTIONS', { origin: 'https://evil.example' })),
    ).toBeNull();
  });
});
