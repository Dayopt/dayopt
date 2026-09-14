/**
 * 開いているページのビルドが、配信中の最新 deploy より古いかを判定する。
 *
 * promote 後に「新しいバージョンがあります」と出していた旧実装は、Service Worker の
 * `controllerchange` だけを見ていた。promote 後に開いた新しいページ自身も新 SW を起動して
 * `controllerchange` を受けるため、既に最新のページにまで更新を求めていた。
 * ここではページ自身の SHA と、新しい SW / サーバーの SHA を比べて本当に古い時だけ true にする。
 */

/** Service Worker の scriptURL（`/sw.js?v=<sha>`）から版を取り出す。無ければ null。 */
export function readServiceWorkerVersion(scriptUrl: string | null | undefined): string | null {
  if (!scriptUrl) return null;
  try {
    const version = new URL(scriptUrl, 'https://placeholder.invalid').searchParams.get('v');
    return version ? version : null;
  } catch {
    return null;
  }
}

/**
 * `controllerchange` を受けた時、このページが古いか。
 *
 * ページの SHA が分からない（Vercel 以外のビルド）場合と、新しい SW の版が読めない場合は、
 * 比較できないので従来通り「古い」とみなす。どちらのケースでも登録 URL は版を持たないため、
 * `controllerchange` が起きるのは sw.js 自体が変わった時だけになる。
 */
export function isStaleOnControllerChange(
  pageSha: string,
  controllerScriptUrl: string | null | undefined,
): boolean {
  if (!pageSha) return true;
  const controllerVersion = readServiceWorkerVersion(controllerScriptUrl);
  if (!controllerVersion) return true;
  return controllerVersion !== pageSha;
}

/**
 * サーバーが返した最新 SHA と比べて、このページが古いか。
 *
 * どちらかが空なら比較できないので古いとはみなさない（自動リロードを誤発火させない側へ倒す）。
 */
export function isStaleAgainstDeployed(
  pageSha: string,
  deployedSha: string | null | undefined,
): boolean {
  if (!pageSha || !deployedSha) return false;
  return deployedSha !== pageSha;
}
