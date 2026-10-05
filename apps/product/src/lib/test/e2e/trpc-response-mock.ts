import type { Route } from '@playwright/test';
import superjson from 'superjson';

import { validatePreviewOrigin } from '../preview-access';

async function fetchMockBatch(route: Route, url: URL) {
  if (!process.env.E2E_PREVIEW_ORIGIN) return route.fetch();
  const origin = validatePreviewOrigin(process.env.E2E_PREVIEW_ORIGIN);
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (url.origin !== origin || !url.pathname.startsWith('/api/trpc/') || !secret) {
    throw new Error('Preview batch mock target is invalid');
  }
  // Page route handlers precede the context fence. Fetch only the pinned first
  // hop here, so neither the bypass nor the synthetic session follows redirects.
  const headers = { ...route.request().headers() };
  delete headers['x-vercel-protection-bypass'];
  delete headers['x-vercel-set-bypass-cookie'];
  return route.fetch({
    maxRedirects: 0,
    headers: { ...headers, 'x-vercel-protection-bypass': secret },
  });
}

/**
 * tRPC httpBatchLink の batch レスポンス envelope を組み立てる E2E 共有ヘルパー。
 *
 * ブラウザ側の tRPC client は `transformer: superjson` + `methodOverride: 'POST'`
 * の httpBatchLink を使う（{@link file://../../trpc/browser-client.ts}）。
 * batch link は単発呼び出しでも配列 envelope を返す前提で応答をパースするため、
 * `page.route` で fulfill する body もこの形に合わせる必要がある。
 *
 * wire format は `[{ result: { data: <serialized> } }]`。`<serialized>` は
 * `@trpc/server` の `transformResultInner` が `transformer.output.serialize` を
 * そのまま呼んだ結果で、superjson を素の transformer として渡している構成では
 * `superjson.serialize(data)`（`{ json, meta? }`）と一致する
 * （`node_modules/@trpc/server/dist/tracked-*.mjs` の `transformTRPCResponseItem` /
 * `transformResultInner` 参照）。手書き JSON で `{ json, meta }` を偽造すると
 * superjson の meta 構造（Date / Map / undefined 等の特殊値エンコード）が
 * 実装とずれても検出できないため、実際の `superjson.serialize` を呼ぶ。
 *
 * `T` を呼び出し元で procedure の実際の出力型に合わせて指定すると、
 * router 側の返り値型が変わった時に mock 呼び出し側で型エラーとして検出できる。
 */
function buildTrpcBatchResponseBody<T>(data: T): string {
  return JSON.stringify([
    {
      result: {
        data: superjson.serialize(data),
      },
    },
  ]);
}

/**
 * `page.route` のハンドラ内で、tRPC procedure が `data` を返したことにして応答する。
 *
 * **単独 batch（HTTP リクエスト 1 件 = procedure 1 件）専用。** httpBatchLink の
 * dataLoader は同一 tick で発火した複数 query を 1 HTTP リクエストへまとめるため
 * （`@trpc/client` の `dataLoader` が `setTimeout(dispatch)` の 1 tick を window に
 * する）、対象 procedure が他の query と同時に batch される可能性がある呼び出しには
 * {@link fulfillTrpcProcedure} を使う。mutation はユーザー操作起点で単独発火するため
 * 通常この関数で足りる（query の dataLoader とは別インスタンスなので他の query と
 * 混ざらない）。
 *
 * @example
 * ```ts
 * await page.route('**\/api/trpc/billing.createCheckoutSession*', (route) =>
 *   fulfillTrpcResponse<CheckoutSessionResponse>(route, { url: DUMMY_CHECKOUT_URL }),
 * );
 * ```
 */
export async function fulfillTrpcResponse<T>(route: Route, data: T): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: buildTrpcBatchResponseBody(data),
  });
}

/**
 * `page.route` に渡す、batch 内のどこに `procedurePath` があっても一致する URL パターン。
 *
 * httpBatchLink は同一 tick で発火した複数 query を `/api/trpc/<path1>,<path2>?batch=1`
 * のようにカンマ結合した 1 リクエストへまとめる。`**\/api/trpc/billing.getOverview*`
 * のような文字列 glob は「その procedure が先頭にある回」にしか一致しない
 * （glob の `**` はワイルドカードだが、後続の固定文字列
 * `/api/trpc/billing.getOverview` はリテラル一致を要求するため）。他の procedure と
 * 同時に batch されて `/api/trpc/userSettings.get,billing.getOverview?batch=1` に
 * なった回は一致せず、`page.route` のハンドラ自体が一度も呼ばれない。この失敗は
 * 静かで、mock が外れた回だけ実サーバーの応答がそのまま画面に出るため、
 * テストは「mock した値と違う画面」を見て落ちる。
 *
 * この関数はカンマ区切りリストのどの位置にあっても一致する正規表現を返す。
 * `fulfillTrpcProcedure` とセットで使う。
 */
export function trpcProcedureRoutePattern(procedurePath: string): RegExp {
  const escaped = procedurePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/api/trpc/(?:[^/?]*,)?${escaped}(?:,[^/?]*)?(?:\\?|$)`);
}

/**
 * `page.route` のハンドラ内で、batch 内の `procedurePath` に対応する要素だけを
 * `data` で差し替えて応答する。他の procedure と同時に batch されるかどうかが
 * 呼び出し元の実装都合（同じ画面の別コンポーネントが並行して発火する prefetch 等）
 * で変わり、テスト側から確定できない query 系 procedure の mock に使う。
 *
 * `page.route` 自体の登録には {@link trpcProcedureRoutePattern} を使うこと。
 * 文字列 glob（`**\/api/trpc/<procedure>*`）で登録すると、対象 procedure が batch の
 * 先頭に無い回はそもそもこのハンドラへ到達しない（上記関数の doc 参照）。
 *
 * 対象 procedure を含まない batch はそのまま実サーバーへ通す。含む場合は
 * 実サーバーの応答を土台にし、対象 procedure の要素だけ差し替える
 * （同時に batch される他 procedure は実際に叩かれてよい前提。副作用や外部 API
 * 依存があって実サーバーに絶対到達させたくない procedure は、ユーザー操作起点の
 * 単独発火である mutation に限定した上で {@link fulfillTrpcResponse} を使う）。
 */
export async function fulfillTrpcProcedure<T>(
  route: Route,
  procedurePath: string,
  data: T,
): Promise<void> {
  const url = new URL(route.request().url());
  const pathSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  const pathList = pathSegment.split(',');
  const targetIndex = pathList.indexOf(procedurePath);

  if (targetIndex === -1) {
    await route.continue();
    return;
  }

  if (pathList.length === 1) {
    await fulfillTrpcResponse(route, data);
    return;
  }

  const response = await fetchMockBatch(route, url);
  const body: unknown = await response.json();
  if (!Array.isArray(body) || body.length !== pathList.length) {
    throw new Error(
      `tRPC batch response の形が想定外でした（procedure ${pathList.length} 件に対し ` +
        `${Array.isArray(body) ? `${body.length} 件` : typeof body}）: ${procedurePath}`,
    );
  }
  body[targetIndex] = { result: { data: superjson.serialize(data) } };
  await route.fulfill({
    response,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
