'use client';

import { createContext, useContext } from 'react';

/** SSR と初回 client render が同じ暦日から始まるための request-scoped 値。 */
const InitialCalendarDateContext = createContext<
  { dateKey: string; needsBrowserDate: boolean } | undefined
>(undefined);

export function InitialCalendarDateProvider({
  dateKey,
  needsBrowserDate = false,
  children,
}: {
  dateKey: string;
  needsBrowserDate?: boolean;
  children: React.ReactNode;
}) {
  return (
    <InitialCalendarDateContext.Provider value={{ dateKey, needsBrowserDate }}>
      {children}
    </InitialCalendarDateContext.Provider>
  );
}

export function useInitialCalendarDate() {
  return useContext(InitialCalendarDateContext)?.dateKey;
}

export function useNeedsBrowserCalendarDate() {
  return useContext(InitialCalendarDateContext)?.needsBrowserDate ?? false;
}
