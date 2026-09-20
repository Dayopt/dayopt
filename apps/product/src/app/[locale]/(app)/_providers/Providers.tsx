/**
 * 認証必須ページ用フルProviders（薄い shell）
 *
 * @description
 * - app/レイヤーの責務を最小化するため、実体は ProvidersComposition へ委譲。
 * - 変更・テストしやすい構造にする。
 *
 * @see ProvidersComposition: tRPC, テーマ, 認証初期化, サイドエフェクト provider の実構成
 */
'use client';

import type { DehydratedState } from '@tanstack/react-query';

import { ProvidersComposition } from './_composition/ProvidersComposition';

interface ProvidersProps {
  children: React.ReactNode;
  dehydratedState?: DehydratedState | undefined;
}

/** 認証必須ページ用フルProviders（shell） */
export function Providers({ children, dehydratedState }: ProvidersProps) {
  return <ProvidersComposition dehydratedState={dehydratedState}>{children}</ProvidersComposition>;
}
