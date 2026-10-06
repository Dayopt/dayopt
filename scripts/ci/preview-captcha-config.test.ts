import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const configPath = new URL('../../supabase/config.toml', import.meta.url);

describe('Supabase Preview CAPTCHA config', () => {
  it('ephemeral Local and PR Preview Auth explicitly disable CAPTCHA', async () => {
    const config = await readFile(configPath, 'utf8');

    expect(config).toMatch(/\[auth\.captcha\]\s+enabled = false/u);
  });
});
