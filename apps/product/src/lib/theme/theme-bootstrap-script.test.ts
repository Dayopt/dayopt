import { describe, expect, it } from 'vitest';

import { resolveInitialTheme, THEME_BOOTSTRAP_SCRIPT } from './theme-bootstrap-script';

describe('resolveInitialTheme', () => {
  it('保存されたテーマを優先し、system / 未保存は OS 設定に従う', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
    expect(resolveInitialTheme('system', true)).toBe('dark');
    expect(resolveInitialTheme('system', false)).toBe('light');
    expect(resolveInitialTheme(null, true)).toBe('dark');
  });
});

describe('THEME_BOOTSTRAP_SCRIPT', () => {
  function run(stored: string | null, prefersDark: boolean): string {
    const classes = new Set<string>();
    const sandbox = {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: prefersDark }),
      document: { documentElement: { classList: { add: (c: string) => classes.add(c) } } },
    };
    // inline script を同じ判定で走らせる（ブラウザ API はサンドボックスで代替）
    new Function('localStorage', 'matchMedia', 'document', THEME_BOOTSTRAP_SCRIPT)(
      sandbox.localStorage,
      sandbox.matchMedia,
      sandbox.document,
    );
    return [...classes].join(',');
  }

  it('resolveInitialTheme と同じ class を付ける', () => {
    expect(run('dark', false)).toBe('dark');
    expect(run('light', true)).toBe('light');
    expect(run('system', true)).toBe('dark');
    expect(run(null, false)).toBe('light');
  });

  it('localStorage が使えなくても例外を外へ出さない', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() =>
      new Function('localStorage', 'matchMedia', 'document', THEME_BOOTSTRAP_SCRIPT)(
        throwing,
        () => ({ matches: true }),
        { documentElement: { classList: { add: () => undefined } } },
      ),
    ).not.toThrow();
  });
});
