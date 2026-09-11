import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV } from '../../apps/product/production-build-gate.mjs';
import { REQUIRED_WEB_OPERATIONAL_BUILD_ENV } from '../../apps/web/production-build-gate.mjs';
import {
  allowedNonLedgerKeys,
  assertProductionFloor,
  buildLedger,
  findUnlistedKeys,
  normalizeEnvKeys,
  runReplicaCheck,
} from '../tasks/env/check-vercel-replica';

/**
 * replica ⊆ 台帳 検査（#2084）の契約を固定する。
 * 守る契約は 2 つ: (1) 値を一切保持・出力しない (2) fail closed
 * （応答が想定外・部分的なら「検出ゼロ = pass」ではなく throw に倒す）。
 */

// secrets:check の実 secret パターン（sk_live_ 等）に一致しない canary。
// 契約は「この文字列が出力に混入しない」ことなので、実 key の形は不要
const SECRET_VALUE = 'canary-value-do-not-leak-1234567890';

function envsResponse(envs: unknown[]): unknown {
  return { envs };
}

/** build gate の必須 key（sanity floor）を production target で満たす entry 群。 */
function floorEnvs(project: 'product' | 'web'): unknown[] {
  const required =
    project === 'product'
      ? REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV
      : REQUIRED_WEB_OPERATIONAL_BUILD_ENV;
  return required.map((key: string) => ({ key, target: ['production'] }));
}

describe('normalizeEnvKeys（値を落とす射影）', () => {
  it('key / targets だけに射影し、value プロパティを一切保持しない', () => {
    const result = normalizeEnvKeys(
      envsResponse([
        {
          key: 'SOME_KEY',
          value: SECRET_VALUE,
          type: 'encrypted',
          target: ['production', 'preview'],
        },
      ]),
    );

    expect(result).toEqual([{ key: 'SOME_KEY', targets: ['production', 'preview'] }]);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('key が string でない entry と object でない entry は黙って落とす', () => {
    const result = normalizeEnvKeys(
      envsResponse([
        { key: 123, target: ['production'] },
        'garbage',
        null,
        { target: ['production'] },
      ]),
    );
    expect(result).toEqual([]);
  });

  it('envs 配列を持たない応答は fail closed で throw する', () => {
    for (const malformed of [null, undefined, 'text', {}, { envs: 'not-array' }]) {
      expect(() => normalizeEnvKeys(malformed)).toThrow(
        'Vercel environment metadata response is invalid',
      );
    }
  });

  it('pagination.next を持つ応答は部分結果として throw する（偽グリーン防止）', () => {
    expect(() =>
      normalizeEnvKeys({ envs: [], pagination: { count: 20, next: 1723600000000 } }),
    ).toThrow('paginated');
    // next が null（最終ページ）は全量なので通す
    expect(normalizeEnvKeys({ envs: [], pagination: { count: 20, next: null } })).toEqual([]);
  });
});

describe('assertProductionFloor（応答欠落の fail closed）', () => {
  it('build gate の必須 key が production target に揃っていれば通る', () => {
    expect(() =>
      assertProductionFloor('product', normalizeEnvKeys(envsResponse(floorEnvs('product')))),
    ).not.toThrow();
  });

  it('空応答は「検出ゼロ = pass」ではなく throw する', () => {
    expect(() => assertProductionFloor('product', [])).toThrow('missing required production keys');
  });

  it('target の表現が変わって production 判定に載らなくなった場合も throw する', () => {
    // target が string になる形状 drift: targets は空になり、floor を割る
    const drifted = normalizeEnvKeys(
      envsResponse(
        floorEnvs('web').map((entry) => ({ ...(entry as object), target: 'production' })),
      ),
    );
    expect(() => assertProductionFloor('web', drifted)).toThrow('missing required production keys');
  });
});

describe('findUnlistedKeys（台帳との突合）', () => {
  const ledger: ReadonlySet<string> = new Set(['IN_LEDGER']);

  it('production target かつ台帳に無い key だけを検出する', () => {
    const entries = [
      { key: 'IN_LEDGER', targets: ['production'] },
      { key: 'NOT_IN_LEDGER', targets: ['production'] },
      { key: 'PREVIEW_ONLY_UNKNOWN', targets: ['preview'] },
    ];
    expect(findUnlistedKeys(entries, ledger)).toEqual(['NOT_IN_LEDGER']);
  });

  it('allowlist に載っている key は検出しない', () => {
    const entries = [{ key: 'ALLOWED', targets: ['production'] }];
    const allowlist = new Map([['ALLOWED', '理由']]);
    expect(findUnlistedKeys(entries, ledger, allowlist)).toEqual([]);
  });

  it('重複を除去し、sort して返す', () => {
    const entries = [
      { key: 'ZZZ', targets: ['production'] },
      { key: 'AAA', targets: ['production'] },
      { key: 'ZZZ', targets: ['production', 'preview'] },
    ];
    expect(findUnlistedKeys(entries, ledger)).toEqual(['AAA', 'ZZZ']);
  });
});

describe('buildLedger / allowedNonLedgerKeys（schema との接続）', () => {
  it('onePasswordEnvSchema の envName を含み、未知の key を含まない', () => {
    const ledger = buildLedger();
    expect(ledger.has('SUPABASE_SECRET_KEY')).toBe(true);
    expect(ledger.has('SENTRY_AUTH_TOKEN')).toBe(true);
    expect(ledger.has('TOTALLY_UNKNOWN_KEY')).toBe(false);
  });

  it('allowlist の各 entry は理由必須（空が既定。#2094 で integration-managed 11 件、#2458 で再注入された SUPABASE_ANON_KEY を例外登録済み。docs/operations/secrets.md §Vercel Production の integration-managed 例外）', () => {
    expect(allowedNonLedgerKeys.size).toBe(10);
    for (const reason of allowedNonLedgerKeys.values()) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  // #2458: #2094 が「手動残骸」として削除した key が、同じ integration から
  // 再注入された（configurationId icfg_ZZhIJpCa3ksZJLqBXjg257gb、2026-08-24）。
  // 削除しても戻るため allowlist 側で扱う。台帳（1Password）へは入れない。
  it('runtime が使う modern keys は未台帳例外にしない', () => {
    for (const key of ['SUPABASE_SECRET_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']) {
      expect(buildLedger().has(key)).toBe(true);
      expect(allowedNonLedgerKeys.has(key)).toBe(false);
    }
  });

  it('SUPABASE_ANON_KEY は allowlist にあり台帳には無い', () => {
    expect(allowedNonLedgerKeys.has('SUPABASE_ANON_KEY')).toBe(true);
    expect(buildLedger().has('SUPABASE_ANON_KEY')).toBe(false);
  });

  it('allowlist にある key は production にあっても未台帳として報告しない', () => {
    const findings = findUnlistedKeys(
      [{ key: 'SUPABASE_ANON_KEY', targets: ['production'] }],
      buildLedger(),
    );
    expect(findings).toEqual([]);
  });
});

describe('runReplicaCheck（end-to-end 契約）', () => {
  function fetchStub(payloadByProject: Record<string, unknown>): typeof fetch {
    return (async (url: URL | RequestInfo) => {
      const href = url instanceof URL ? url.href : String(url);
      // 値の復号を要求する query が紛れ込む回帰を構造的に止める
      expect(href).not.toContain('decrypt');
      const project = href.includes('/projects/product/') ? 'product' : 'web';
      return {
        ok: true,
        status: 200,
        json: async () => payloadByProject[project],
      } as Response;
    }) as typeof fetch;
  }

  it('token / teamId が無ければ throw する（fail closed）', async () => {
    await expect(runReplicaCheck({ token: undefined, teamId: 't' })).rejects.toThrow(
      'VERCEL_TOKEN is required',
    );
    await expect(runReplicaCheck({ token: 'x', teamId: undefined })).rejects.toThrow(
      'VERCEL_TEAM_ID is required',
    );
  });

  it('両 project を検査し、findings に値を含めない', async () => {
    const payload = envsResponse([
      ...floorEnvs('product'),
      { key: 'NOT_IN_LEDGER', value: SECRET_VALUE, target: ['production'] },
      { key: 'SUPABASE_SECRET_KEY', value: SECRET_VALUE, target: ['production'] },
    ]);
    const findings = await runReplicaCheck({
      token: 'x',
      teamId: 't',
      fetchImpl: fetchStub({ product: payload, web: envsResponse(floorEnvs('web')) }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('product: NOT_IN_LEDGER');
    expect(findings.join('\n')).not.toContain(SECRET_VALUE);
  });

  it('HTTP エラーはレスポンス本文を echo せず status だけで throw する', async () => {
    const failingFetch = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: SECRET_VALUE } }),
      }) as Response) as typeof fetch;

    await expect(
      runReplicaCheck({ token: 'x', teamId: 't', fetchImpl: failingFetch }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('status 401') && !message.includes(SECRET_VALUE);
    });
  });

  it('JSON でない本文は SyntaxError の断片を伝播させず固定文言で throw する', async () => {
    const nonJsonFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          // V8 の SyntaxError は message に入力断片を埋め込む。この形が
          // console.error まで届かないことを固定する
          throw new SyntaxError(`Unexpected token '<', "<html>${SECRET_VALUE}" is not valid JSON`);
        },
      }) as unknown as Response) as typeof fetch;

    await expect(
      runReplicaCheck({ token: 'x', teamId: 't', fetchImpl: nonJsonFetch }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('was not JSON') && !message.includes(SECRET_VALUE);
    });
  });

  it('想定外の応答形は pass ではなく throw に倒す', async () => {
    await expect(
      runReplicaCheck({
        token: 'x',
        teamId: 't',
        fetchImpl: fetchStub({ product: { unexpected: true }, web: envsResponse([]) }),
      }),
    ).rejects.toThrow('Vercel environment metadata response is invalid');
  });

  it('floor を割る応答（truncation / 空）は pass ではなく throw に倒す', async () => {
    await expect(
      runReplicaCheck({
        token: 'x',
        teamId: 't',
        fetchImpl: fetchStub({ product: envsResponse([]), web: envsResponse(floorEnvs('web')) }),
      }),
    ).rejects.toThrow('missing required production keys');
  });
});

describe('entry point guard（fail open の再導入防止）', () => {
  it('素の import.meta.url 比較ではなく realpath 正規化で判定する（2026-08-11 実測の再発防止）', () => {
    const source = readFileSync(
      new URL('../tasks/env/check-vercel-replica.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('pathToFileURL(realpathSync(process.argv[1]))');
    expect(source).not.toMatch(/if \(import\.meta\.url === `file:\/\//);
  });
});
