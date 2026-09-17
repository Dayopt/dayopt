'use client';

import { createContext, useContext } from 'react';

/** SSR と初回 client render が同じ暦日から始まるための request-scoped 値。 */
const InitialCalendarDateContext = createContext<string | undefined>(undefined);

export function InitialCalendarDateProvider({
  dateKey,
  children,
}: {
  dateKey: string;
  children: React.ReactNode;
}) {
  return (
    <InitialCalendarDateContext.Provider value={dateKey}>
      {children}
    </InitialCalendarDateContext.Provider>
  );
}

export function useInitialCalendarDate() {
  return useContext(InitialCalendarDateContext);
}
