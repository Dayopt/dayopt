import { NextResponse } from 'next/server';

import { APP_VERSION, getBuildSha } from '@/lib/app-info';

/** ビルド時に確定した定数を返すだけで、外部 I/O も await も無い。 */
export const maxDuration = 15;

/**
 * 配信中のビルドの版を返す軽量エンドポイント
 *
 * 開きっぱなしのタブがフォーカスを取り戻した時に叩き、自分より新しい deploy が
 * 配信されていれば自動でリロードする（`useServiceWorker`）。DB や Redis には触らない。
 * 稼働確認は `/api/health` の役目で、ここは版の比較だけに使う。
 */
export function GET() {
  return NextResponse.json(
    { version: APP_VERSION, commitSha: getBuildSha() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
