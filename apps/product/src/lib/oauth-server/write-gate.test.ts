import { afterEach, describe, expect, it, vi } from 'vitest';

import { isConsentWriteEnabled, isWriteEnabledByMutationControl } from './write-gate';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllEnvs();
});

type ControlRow = { writes_enabled: boolean; enabled_client_ids: string[] };

function createDb(result: { data: ControlRow | null; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    })),
  };
  return db as unknown as Parameters<typeof isConsentWriteEnabled>[0];
}

describe('isWriteEnabledByMutationControl', () => {
  it('global gate と client allowlist の両方が許可した時だけ true', () => {
    expect(
      isWriteEnabledByMutationControl(
        { writes_enabled: true, enabled_client_ids: ['claude-ai'] },
        'claude-ai',
      ),
    ).toBe(true);
    expect(
      isWriteEnabledByMutationControl(
        { writes_enabled: false, enabled_client_ids: ['claude-ai'] },
        'claude-ai',
      ),
    ).toBe(false);
    expect(
      isWriteEnabledByMutationControl(
        { writes_enabled: true, enabled_client_ids: ['chatgpt'] },
        'claude-ai',
      ),
    ).toBe(false);
  });

  it('control 行が無ければ false（fail-closed）', () => {
    expect(isWriteEnabledByMutationControl(null, 'claude-ai')).toBe(false);
  });
});

describe('isConsentWriteEnabled', () => {
  it('env allowlist に無い client は DB を読まずに false', async () => {
    const db = createDb({
      data: { writes_enabled: true, enabled_client_ids: ['claude-ai'] },
      error: null,
    });

    await expect(isConsentWriteEnabled(db, 'claude-ai')).resolves.toBe(false);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it('env allowlist にあり DB gate も開いていれば true', async () => {
    vi.stubEnv('MCP_WRITE_ENABLED_CLIENTS', 'claude-ai');
    const db = createDb({
      data: { writes_enabled: true, enabled_client_ids: ['claude-ai'] },
      error: null,
    });

    await expect(isConsentWriteEnabled(db, 'claude-ai')).resolves.toBe(true);
  });

  // 緊急停止の第一手は DB gate を閉じること。ここで true のままだと grant RPC が
  // DM003 で落ち、その client からは read-only の新規接続すらできなくなる。
  it('env は開いていても DB gate が閉じていれば false', async () => {
    vi.stubEnv('MCP_WRITE_ENABLED_CLIENTS', 'claude-ai');
    const db = createDb({ data: { writes_enabled: true, enabled_client_ids: [] }, error: null });

    await expect(isConsentWriteEnabled(db, 'claude-ai')).resolves.toBe(false);
  });

  it('DB を読めない時は false へ倒す（read-only の grant は成立させる）', async () => {
    vi.stubEnv('MCP_WRITE_ENABLED_CLIENTS', 'claude-ai');
    const db = createDb({ data: null, error: { message: 'boom' } });

    await expect(isConsentWriteEnabled(db, 'claude-ai')).resolves.toBe(false);
  });
});
