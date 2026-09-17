import { getDateKey } from '@/lib/date';
import { headers } from 'next/headers';
import { cache } from 'react';

/**
 * 同じRSCリクエストで app shell と calendar prefetch が使う暦日。
 * React cache は request ごとに破棄されるため、ユーザー間で共有されない。
 */
export const getRequestCalendarDate = cache(async () => {
  const requestHeaders = await headers();
  const timezoneHeader = requestHeaders.get('x-user-timezone');
  const timezone = timezoneHeader ?? 'UTC';

  try {
    return {
      dateKey: getDateKey(new Date(), timezone),
      timezone,
      hasBrowserTimezone: timezoneHeader !== null,
    };
  } catch {
    return {
      dateKey: getDateKey(new Date(), 'UTC'),
      timezone: 'UTC',
      hasBrowserTimezone: false,
    };
  }
});
