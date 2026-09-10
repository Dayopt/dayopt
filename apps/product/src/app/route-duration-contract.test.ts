import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * Product の全 route handler の Function 実行時間上限（#1701 Phase 2）。
 *
 * 値は「速そうだから短く」ではなく **内側の timeout 定数から導出する**。小さすぎると
 * handler が自前のエラー応答を返す前に kill され、graceful failure（4xx/5xx の JSON）が
 * Vercel の 504 に化ける。既存の cron が `maxDuration 60` に対し内部予算
 * `TIME_BUDGET_MS = 50_000` を持つのと同じ規律。
 *
 * **この test が保証するのは「下限」であって worst path ではない。** 下の不等式チェックは
 * 「Supabase 1 往復 + rate limit 1 回」を下回らないことしか見ない。依存が全部同時に
 * それぞれの timeout まで張り付く理論上の worst path は、一部の route で予算を超える:
 *
 * - `api/integrations/google-calendar/callback`（90）— getUser 15 + rate limit 2 +
 *   Pro 判定 15 + Google token 交換 15 + connection write 15 ≒ 62s。#1990 で token 交換
 *   （code 消費）の直前に残り予算を検査するようになったため、消費後に kill される経路
 *   自体は塞がれている（予算不足なら code を使わず安全に失敗する）。maxDuration=90 は
 *   その予算検査（`POST_EXCHANGE_BUDGET_MS=45s`）を維持したまま、消費前フェーズの
 *   スラックを確保するための値（指揮台決定、PR #2075 クロスレビュー）
 * - `api/mcp`（120）— 認証フェーズが逐次 getUser 15 × 5 ≒ 75s で 60 を超えるため、
 *   段の値には戻せていない（#1990 の「検討する」項目、未着手）
 * - `api/trpc/[trpc]`（60）— #1965 で `externalCalendar.syncNow` / `updateSelectedCalendars`
 *   が呼ぶ `syncConnection`（procedure の dispatch 数に上限が無い理由だった最大の既知
 *   要因）に wall-clock 予算を持たせたため段の値まで下げられた。#2079 で
 *   `listProviderCalendars` にも同型の予算を持たせ、ページ開始前の判定で pagination ループ
 *   自体は有界化した。**in-flight 1 リクエストの overshoot も #2102 で解消済み**（#2089 の
 *   追跡先） — `requestTimeoutMs` が retry の 2 回目リクエストでも `deadlineAt - Date.now()`
 *   から signal timeout を再計算するため、1 回目のリクエストが rate limit されて retry
 *   しても、2 回目の signal timeout は固定 `GOOGLE_API_TIMEOUT_MS`（15s）ではなくその時点の
 *   残り予算まで絞られる。したがって総経過時間は残余予算の大小によらず `deadlineAt` 付近に
 *   収まる（残余が大きい場合の総経過 ~32s は残余の内側に収まる。特定の残余予算帯だけ
 *   overshoot が残る、という構造ではない）。maxDuration=60 のマージンは、この
 *   deadline 側の予算設計が担う。`disconnect` は同じ issue（#2079）で検討した上で導入しない
 *   結論（`connection-service.ts` の `disconnect()` docstring 参照 — idempotent な retry と
 *   fail-closed 保証を優先）。他 procedure の worst path 全数監査はしていない
 *
 * これらを「全依存が同時に張り付く」ケースまでカバーする値へ引き上げると障害半径を絞る
 * という目的そのものを失う。**予算は blast radius の上限であって、全依存同時ハング時の
 * 完走保証ではない**、という位置づけで運用する。その状況では接続はどのみち失敗しており、
 * 504 と graceful error の差は小さい。
 *
 * したがって **test が通ること＝安全、ではない**。新しい route を足す時は、この表の値を
 * 埋めるだけでなく、その route の worst path を自分で数えること。
 */
const ROUTE_DURATION_CONTRACT = {
  // 外部 I/O 無し
  'src/app/.well-known/oauth-authorization-server/route.ts': 15,
  'src/app/.well-known/oauth-protected-resource/route.ts': 15,
  'src/app/api/v1/system/[...retired]/route.ts': 5,
  'src/app/maintenance/route.ts': 15,

  // 外部 I/O 1-2 本
  'src/app/api/csp-report/route.ts': 30,
  'src/app/api/health/route.ts': 30,

  // 既存値（この PR 以前から production で稼働している値。導出段に当てはめ直していない）。
  //
  // webhooks/stripe は durable lifecycle の worst path が Stripe API 2 本 + DB 数往復 +
  // Resend + analytics の約 9 逐次 hop あり、段の分類としては「複数逐次」に近い。それでも
  // 30 を据え置くのは、(1) この値自体は本 PR の変更ではなく production 実績がある、
  // (2) timeout 時は Stripe 側が再送し、`claimStripeWebhookEvent` の冪等性が二重処理を防ぐ、
  // の 2 点による。引き上げるかどうかは実測（p99）を見てから別途判断する。
  'src/app/api/webhooks/resend/route.ts': 30,
  'src/app/api/webhooks/stripe/route.ts': 30,

  // 外部 I/O が複数逐次
  'src/app/[locale]/(auth)/auth/callback/route.ts': 60,
  'src/app/[locale]/(auth)/auth/confirm/route.ts': 60,
  // #2055(b): list_expired_calendar_account_deletion_intents_v1 →
  // normalize_calendar_account_deletion_intent_v1 を候補ごとに順次呼ぶ（RPC 1 本あたり数秒級 ×
  // 最大 10 件）。予算不等式は settle-dispatcher.ts の SETTLE_WORST_CASE_MS を route.test.ts が
  // 実測で固定する。
  'src/app/api/cron/calendar-account-deletion-settle/route.ts': 60,
  'src/app/api/cron/billing-reconciliation/route.ts': 60,
  'src/app/api/cron/calendar-sync/route.ts': 60,
  'src/app/api/cron/external-connection-maintenance/route.ts': 60,
  'src/app/api/integrations/google-calendar/start/route.ts': 60,
  'src/app/api/oauth/token/route.ts': 60,
  'src/app/api/v1/calendar/[token]/route.ts': 60,
  'src/app/oauth/token/route.ts': 60,
  // #1990: token 交換（code 消費）の直前で残り予算を検査するようになったため、逐次 worst
  // path（77s）を 60 が下回っていても kill 時の失敗の質が変わり安全側になった。90 は
  // その安全性を保ったまま、消費前フェーズの可用性の崖を除去するための値
  // （指揮台決定、PR #2075 クロスレビュー。詳細は maxDuration 直上のコメント）。
  'src/app/api/integrations/google-calendar/callback/route.ts': 90,
  // #1965: externalCalendar.syncConnection に wall-clock 予算を持たせたため、procedure の
  // dispatch 数に上限が無いという構造的な理由がなくなり、段の値へ戻せた。#2079 で
  // listProviderCalendars にも同型の予算を追加済み（in-flight overshoot の残余は #2089）。
  // disconnect は #2079 で検討の上、導入しない結論（connection-service.ts の disconnect()
  // docstring 参照）。
  'src/app/api/trpc/[trpc]/route.ts': 60,

  // 逐次 worst path が 60 を超えるため段から外した route。MCP の認証フェーズは
  // getUser 15 × 5 ≒ 75s で、#1990 のような「不可逆操作の前に予算検査」で吸収できる形の
  // 失敗点が無い（認証自体が worst path の大半を占める）ため未着手。
  'src/app/api/mcp/route.ts': 120,
  'src/app/mcp/route.ts': 120,
} as const;

/**
 * 外部 I/O をしない route。§内側 timeout の下限 の対象外にする。
 *
 * ここへ足すのは「本当に外部へ出ない」route だけ。安易に足すと下限チェックが空洞化する。
 */
const NO_EXTERNAL_IO_ROUTES = new Set<string>([
  'src/app/.well-known/oauth-authorization-server/route.ts',
  'src/app/.well-known/oauth-protected-resource/route.ts',
  'src/app/api/v1/system/[...retired]/route.ts',
  'src/app/maintenance/route.ts',
]);

/**
 * 内側 timeout は import ではなく **source から読む**。
 *
 * route module や `lib/supabase/server.ts` を import すると env 検証・Sentry 初期化・
 * `next/headers` が走って test が環境依存になる。source を読む形なら副作用ゼロで、
 * 定数が動けば正規表現が外れて fail closed になる。
 */
function readTimeoutConstant(relativePath: string, pattern: RegExp): number {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
  const matched = source.match(pattern);

  if (!matched?.[1]) {
    throw new Error(
      `${relativePath} から timeout 定数を読めなかった。定数の書き方が変わったなら、この test の正規表現と ROUTE_DURATION_CONTRACT の値を両方見直すこと。`,
    );
  }

  return Number(matched[1].replaceAll('_', ''));
}

describe('Product route duration contract', () => {
  it('全 route が静的な maxDuration を明示する', () => {
    // `dot: true` が無いと `.well-known` 配下の 2 route を取りこぼし、契約表から静かに漏れる
    // （実測: 付けないと 19 件、付けると 21 件）。
    const discoveredRoutes = globSync('src/app/**/route.{ts,tsx}', {
      cwd: process.cwd(),
      dot: true,
    }).sort();
    const contractRoutes = Object.keys(ROUTE_DURATION_CONTRACT).sort();

    const missing = discoveredRoutes.filter((route) => !contractRoutes.includes(route));
    const stale = contractRoutes.filter((route) => !discoveredRoutes.includes(route));

    expect(
      { missing, stale },
      '新しい route を足したら ROUTE_DURATION_CONTRACT にも 1 行足すこと（route を消したら削ること）',
    ).toEqual({ missing: [], stale: [] });

    for (const [routePath, maxDuration] of Object.entries(ROUTE_DURATION_CONTRACT)) {
      const source = readFileSync(resolve(process.cwd(), routePath), 'utf8');

      // Next.js は route segment config を静的解析するため、数値リテラルでなければ効かない。
      expect(
        source,
        `${routePath} は maxDuration = ${maxDuration} を数値リテラルで export すること`,
      ).toMatch(new RegExp(`export\\s+const\\s+maxDuration\\s*=\\s*${maxDuration}\\s*;`));
    }
  });

  it('vercel.json は route config と競合する functions override を持たない', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(config).not.toHaveProperty('functions');
  });

  it('外部 I/O を行う route の maxDuration が内側 timeout の下限を上回る', () => {
    const supabaseFetchTimeoutMs = readTimeoutConstant(
      'src/lib/supabase/server.ts',
      /AbortSignal\.timeout\((\d[\d_]*)\)/u,
    );
    const rateLimitTimeoutMs = readTimeoutConstant(
      'src/lib/rate-limit/upstash.ts',
      /RATE_LIMIT_TIMEOUT_MS\s*=\s*(\d[\d_]*)/u,
    );

    // 「Supabase 1 往復 + rate limit 1 回」すら完走できない route を作らないための床。
    // 内側 timeout を伸ばした変更が route を黙って kill 側へ倒すのを、ここで落とす。
    const floorMs = supabaseFetchTimeoutMs + rateLimitTimeoutMs;

    const tooTight = Object.entries(ROUTE_DURATION_CONTRACT)
      .filter(([routePath]) => !NO_EXTERNAL_IO_ROUTES.has(routePath))
      .filter(([, maxDuration]) => maxDuration * 1000 < floorMs)
      .map(([routePath, maxDuration]) => `${routePath} (${maxDuration}s < ${floorMs / 1000}s)`);

    expect(
      tooTight,
      `内側 timeout の合計 ${floorMs}ms を下回る route がある。maxDuration を上げるか、内側 timeout を短くすること`,
    ).toEqual([]);
  });
});
