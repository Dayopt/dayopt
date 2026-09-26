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
    {
      version: APP_VERSION,
      commitSha: getBuildSha(),
      ...(process.env.VERCEL_ENV === 'preview' ? { preview: getPreviewIdentity() } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** 公開済みの識別子だけを返す。欠測・不正値では生envを返さない。 */
function getPreviewIdentity(): {
  deploymentId: string;
  sha: string;
  supabaseProjectRef: string;
} | null {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const match = /^https:\/\/([a-z]{20})\.supabase\.co\/?$/.exec(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  );
  if (
    !deploymentId ||
    !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !match?.[1]
  )
    return null;
  return { deploymentId, sha, supabaseProjectRef: match[1] };
}
