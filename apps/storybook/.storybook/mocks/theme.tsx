import { type ReactNode, useMemo } from 'react';

import { ThemeContext } from '@/app/[locale]/(app)/_providers/theme-provider';

const noop = () => {};

/** Storybook用の軽量ThemeProvider — tRPC/DB不要でuseDarkModeと連動 */
export function StorybookThemeProvider({
  children,
  resolvedTheme,
}: {
  children: ReactNode;
  resolvedTheme: 'light' | 'dark';
}) {
  const value = useMemo(
    () => ({
      theme: 'system' as const,
      colorScheme: 'blue' as const,
      setTheme: noop,
      setColorScheme: noop,
      resolvedTheme,
      isPending: false,
    }),
    [resolvedTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
