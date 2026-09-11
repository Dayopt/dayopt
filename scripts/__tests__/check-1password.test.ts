import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { forbiddenFields, onePasswordEnvSchema } from '../tasks/env/schema';

const rootDir = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];
const sentinelSecret = 'sentinel-secret-must-not-appear';

const fakeOpScript = `#!/bin/sh
case "$1" in
  --version)
    printf '%s\n' '2.0.0'
    ;;
  account)
    printf '%s\n' '[]'
    ;;
  vault)
    # op vault get <vault> → $3=vault
    if [ -n "$FAKE_OP_MISSING_VAULT" ] && [ "$3" = "$FAKE_OP_MISSING_VAULT" ]; then
      exit 1
    fi
    exit 0
    ;;
  item)
    if [ -n "$FAKE_OP_MISSING_ITEM" ] && [ "$3" = "$FAKE_OP_MISSING_ITEM" ]; then
      exit 1
    fi
    case "$FAKE_OP_MODE" in
      error)
        printf '%s\n' "$FAKE_OP_SENTINEL" >&2
        exit 1
        ;;
      invalid-json)
        printf '%s\n' "$FAKE_OP_SENTINEL"
        ;;
      *)
        # op item get <item> --vault <vault> --format=json → $3=item, $5=vault
        if [ "$3" = "supabase" ] && [ "$5" = "agent" ]; then
          printf '%s\n' "$FAKE_OP_STAGING_SUPABASE_JSON"
        else
          printf '%s\n' "$FAKE_OP_ITEM_JSON"
        fi
        ;;
    esac
    ;;
esac
`;

function createFakeOpDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-fake-op-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'op'), fakeOpScript, { mode: 0o755 });
  return directory;
}

interface CheckOptions {
  emptyField?: string;
  missingItem?: string;
  mode?: 'error' | 'invalid-json';
  /** true にすると agent/supabase が禁止 field を持ったまま残っている状態を再現する */
  leakForbidden?: boolean;
  /** op vault get を失敗させる vault 名（不在 / 権限不足 / 一時エラーの再現） */
  missingVault?: string;
}

function runCheck(options: CheckOptions = {}) {
  const fakeOpDirectory = createFakeOpDirectory();
  const fields = [
    ...new Set([
      ...onePasswordEnvSchema.map((entry) => entry.field),
      ...forbiddenFields.map((entry) => entry.field),
    ]),
  ].map((field) => ({
    id: field,
    label: field,
    value: field === options.emptyField ? '' : sentinelSecret,
  }));

  // 既定の agent/supabase は禁止 field を持たない（是正済みの状態）
  const forbiddenNames = new Set(
    forbiddenFields
      .filter((entry) => entry.vault === 'agent' && entry.item === 'supabase')
      .map((entry) => entry.field),
  );
  const stagingSupabaseFields = options.leakForbidden
    ? fields
    : fields.filter((field) => !forbiddenNames.has(field.id));

  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/env/check-1password.ts'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_OP_ITEM_JSON: JSON.stringify({ fields }),
      FAKE_OP_MISSING_ITEM: options.missingItem ?? '',
      FAKE_OP_MISSING_VAULT: options.missingVault ?? '',
      FAKE_OP_MODE: options.mode ?? '',
      FAKE_OP_SENTINEL: sentinelSecret,
      FAKE_OP_STAGING_SUPABASE_JSON: JSON.stringify({ fields: stagingSupabaseFields }),
      PATH: `${fakeOpDirectory}:${process.env.PATH ?? ''}`,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('check-1password.ts', () => {
  it('参照先と状態だけを表示し、取得した値を出力しない', () => {
    const result = runCheck();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('human / supabase / SUPABASE_SECRET_KEY: OK');
    expect(result.stdout).not.toContain(sentinelSecret);
    expect(result.stderr).not.toContain(sentinelSecret);
  });

  it('op の失敗出力を引き継がない', () => {
    const result = runCheck({ mode: 'error' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MISSING_ITEM');
    expect(result.stdout).not.toContain(sentinelSecret);
    expect(result.stderr).not.toContain(sentinelSecret);
  });

  it('不正な JSON の raw stdout を引き継がない', () => {
    const result = runCheck({ mode: 'invalid-json' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MISSING_ITEM');
    expect(result.stdout).not.toContain(sentinelSecret);
    expect(result.stderr).not.toContain(sentinelSecret);
  });

  it('optional item が未作成でも状態を表示して成功する', () => {
    const result = runCheck({ missingItem: 'google' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('agent / google / GOOGLE_SITE_VERIFICATION: MISSING_ITEM');
  });

  it('optional field が空でも状態を表示して成功する', () => {
    const result = runCheck({ emptyField: 'GOOGLE_SITE_VERIFICATION' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('agent / google / GOOGLE_SITE_VERIFICATION: EMPTY');
  });

  it('pendingReason を持つ entry が非 OK の時、理由を添えて表示する', () => {
    const result = runCheck({ emptyField: 'STRIPE_ACCOUNT_ID' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('human / stripe-live / STRIPE_ACCOUNT_ID: EMPTY');
    expect(result.stdout).toContain('  └ pending: 課金未有効化のため未設定');
  });

  it('pendingReason を持つ entry でも OK の時は理由を表示しない', () => {
    const result = runCheck();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('  └ pending:');
  });

  it('required item が未作成なら失敗する', () => {
    const result = runCheck({ missingItem: 'sentry-web' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('human / sentry-web / SENTRY_DSN: MISSING_ITEM');
  });

  it('required field が空なら失敗する', () => {
    const result = runCheck({ emptyField: 'SENTRY_DSN' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('human / sentry / SENTRY_DSN: EMPTY');
  });

  it('required operational item が未作成なら失敗する', () => {
    const result = runCheck({ missingItem: 'github-ssh' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('human / github-ssh: MISSING_ITEM');
  });

  it('禁止 field が実 vault に残っていたら失敗する', () => {
    const result = runCheck({ leakForbidden: true });

    expect(result.status).toBe(1);
    for (const entry of forbiddenFields) {
      expect(result.stdout, entry.field).toContain(
        `${entry.vault} / ${entry.item} / ${entry.field}: FORBIDDEN_PRESENT`,
      );
    }
    expect(result.stdout).not.toContain(sentinelSecret);
  });

  it('禁止 field が削除済みなら ABSENT を表示して成功する', () => {
    const result = runCheck();

    expect(result.status, result.stderr).toBe(0);
    for (const entry of forbiddenFields) {
      expect(result.stdout, entry.field).toContain(
        `${entry.vault} / ${entry.item} / ${entry.field}: ABSENT`,
      );
    }
  });

  it('vault を取得できない時は禁止 field の不在を確認できないので失敗する', () => {
    const result = runCheck({ missingVault: 'agent' });

    expect(result.status).toBe(1);
    for (const entry of forbiddenFields.filter((f) => f.vault === 'agent')) {
      expect(result.stdout, entry.field).toContain(
        `${entry.vault} / ${entry.item} / ${entry.field}: UNVERIFIABLE`,
      );
    }
    // 権限不足や一時エラーを「不在を確認できた」と読み替えない
    expect(result.stdout).not.toContain('agent / supabase / SUPABASE_DB_PASSWORD: ABSENT');
  });

  it('item を取得できない時も禁止 field の不在を確認できないので失敗する', () => {
    // agent/supabase の通常 entry はすべて optional なので、
    // 禁止 field 検査が通してしまうと checker 全体が exit 0 になりうる
    const result = runCheck({ missingItem: 'supabase' });

    expect(result.status).toBe(1);
    for (const entry of forbiddenFields.filter((f) => f.item === 'supabase')) {
      expect(result.stdout, entry.field).toContain(
        `${entry.vault} / ${entry.item} / ${entry.field}: UNVERIFIABLE`,
      );
      expect(result.stdout, entry.field).not.toContain(
        `${entry.vault} / ${entry.item} / ${entry.field}: ABSENT`,
      );
    }
  });

  it.each([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ])('production の Supabase %s が欠けたら失敗する', (field) => {
    // Staging 側の複製を撤去した分の required 検査は production へ移した。
    // 欠けると runtime だけでなく .op-env.human 経由の管理者運用も止まる。
    const result = runCheck({ emptyField: field });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`human / supabase / ${field}: EMPTY`);
  });

  it('op が壊れた応答を返す時も禁止 field を ABSENT と判定しない', () => {
    for (const mode of ['error', 'invalid-json'] as const) {
      const result = runCheck({ mode });

      expect(result.status, mode).toBe(1);
      for (const entry of forbiddenFields) {
        expect(result.stdout, `${mode}/${entry.field}`).not.toContain(
          `${entry.vault} / ${entry.item} / ${entry.field}: ABSENT`,
        );
      }
    }
  });
});
