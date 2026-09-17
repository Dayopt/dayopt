import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * service-role client を作る module は、必ず外部呼び出しの上限を持つ、という契約。
 *
 * 上限が無いと Supabase 呼び出しが無制限になり、route の `maxDuration` だけが先に発火して
 * Function が kill される。handler は自前のエラー応答を返せず、Vercel の 504 になる。
 *
 * **特に危ないのは 1 回しか使えない grant を消費する経路**（OAuth authorization code、
 * refresh token rotation、Google の authorization code）。「サーバー側では成功したが
 * レスポンスが返らない」状態を作ると、client は再試行しても使用済みエラーで詰み、
 * ユーザーは認可からやり直しになる。内側で先に切れば正規のエラーを返せて回復できる。
 *
 * ## なぜ test にするか
 *
 * 2026-08-12、route の `maxDuration` を 300 → 60 秒へ下げた際に、外部レビューが同型の
 * 欠落を **3 つの factory で連続検出**した（`lib/oauth-server/db.ts` /
 * `lib/mcp/access-db.ts` / `external-calendar/server/connection-service.ts`）。3 件とも
 * 実際に漏れていた。1 件ずつ潰すのではなく class ごと閉じるためにこの test を置く
 * （`AGENTS.md §PR / git 運用` §同型指摘の打ち切り「点の追加ではなく class ごと閉じる」）。
 *
 * ## 判定は factory の `global.fetch` を見る
 *
 * 当初は「file 内に `AbortSignal.timeout` が 1 つでもあれば合格」にしていたが、
 * **それでは足りない**と外部レビューが指摘した。`token-rotation.ts` は一部 RPC にだけ
 * `.abortSignal()` があり、legacy 分岐の `.update().maybeSingle()` と
 * `readLegacyConnection()` は無制限のまま合格していた（2026-08-12 実測）。
 *
 * そこで **client 生成時の `global.fetch` に上限があること**を要求する。ここに床が
 * あれば、個別 query に `.abortSignal()` を付け忘れても無制限にはならない。個別の
 * `.abortSignal()` はより短い上書きとして併用してよい。
 */
const SERVICE_ROLE_KEY_REFERENCE = 'SUPABASE_SECRET_KEY';

describe('service-role client timeout contract', () => {
  it('service-role client の factory は global.fetch に上限を持つ', () => {
    const sources = globSync('src/**/*.ts', {
      cwd: process.cwd(),
      dot: true,
      ignore: ['src/**/*.test.{ts,tsx}', 'src/lib/test/**'],
    }).sort();

    const inspected: string[] = [];
    const offenders: string[] = [];

    for (const relativePath of sources) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');

      const createsServiceRoleClient =
        source.includes(SERVICE_ROLE_KEY_REFERENCE) && /createClient[<(]/u.test(source);
      if (!createsServiceRoleClient) continue;

      inspected.push(relativePath);

      // `createClient(...)` の options に `global.fetch` があり、その中で timeout を
      // 張っていることを要求する。file のどこかに `AbortSignal.timeout` があるだけでは
      // 通さない（個別 query にだけ付いていて factory は無制限、を弾くため）。
      const hasFetchFloor = /global:\s*\{[\s\S]*?fetch:[\s\S]*?AbortSignal\.timeout\(/u.test(
        source,
      );
      if (!hasFetchFloor) offenders.push(relativePath);
    }

    // 対象ゼロで緑になる（glob や判定条件が壊れた）のを防ぐ。
    expect(
      inspected.length,
      'service-role client を作る module を 1 つも検出できていない',
    ).toBeGreaterThan(5);

    expect(
      offenders,
      'service-role client の factory に上限が無い。createClient の options へ `global: { fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(...) }) }` を足すこと（個別 query の .abortSignal() は併用可だが、付け忘れを防ぐ床にはならない）',
    ).toEqual([]);
  });
});
