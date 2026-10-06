'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import styles from './PreferenceSelect.module.css';

const themeOptions = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

export function ThemeSelect({
  label,
  names,
}: {
  label: string;
  names: Record<'light' | 'dark' | 'system', string>;
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const value = mounted ? theme || 'system' : 'system';
  const Icon = themeOptions.find((option) => option.value === value)?.icon || Monitor;

  return (
    <div className={styles.control}>
      <Icon aria-hidden="true" />
      <select
        aria-label={label}
        value={value}
        disabled={!mounted}
        onChange={(event) => setTheme(event.target.value)}
      >
        {themeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {names[option.value]}
          </option>
        ))}
      </select>
    </div>
  );
}
