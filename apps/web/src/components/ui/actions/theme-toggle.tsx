'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@dayopt/components';
import { ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import * as React from 'react';

const themeOptions = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

export function ThemeToggle() {
  const t = useTranslations('common.appearance');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const currentTheme = themeOptions.find((t) => t.value === theme) || themeOptions[2];
  const CurrentIcon = currentTheme.icon;

  if (!mounted) {
    return (
      <Button variant="ghost" size="default" disabled>
        <Sun className="size-4" />
        <ChevronDown className="size-3" />
      </Button>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="default" aria-label={t('changeTheme')}>
          <CurrentIcon className="size-4" />
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {themeOptions.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={theme === option.value}
            onCheckedChange={() => setTheme(option.value)}
          >
            <span className="flex items-center gap-2">
              <option.icon className="size-4" />
              {t(option.value)}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
