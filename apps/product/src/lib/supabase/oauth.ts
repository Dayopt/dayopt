import 'server-only';

/**
 * Supabase OAuth 2.1 認証ユーティリティ
 *
 * MCP連携のためのOAuth 2.1準拠の認証機能
 *
 * @see https://modelcontextprotocol.io/specification/draft/basic/authorization
 * @see RFC 7636 - PKCE (Proof Key for Code Exchange)
 * @see RFC 8707 - Resource Indicators
 *
 * 主な機能:
 * - OAuth 2.1トークン検証（Bearer Token）
 * - Resource Indicators対応
 * - Service Role Client作成（管理者操作用）
 *
 * 使用例:
 * ```tsx
 * // MCPサーバーからのリクエスト処理
 * import { verifyOAuthToken, createServiceRoleClient } from '@/lib/supabase/oauth'
 *
 * const authHeader = req.headers.get('Authorization')
 * const token = extractBearerToken(authHeader)
 *
 * const { userId, client } = await verifyOAuthToken(token)
 * // userId を使ってRLS適用のクエリ実行
 * ```
 */

import { createClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * OAuth 2.1エラー
 */
export class OAuthError extends Error {
  constructor(
    public readonly code: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'MISSING_TOKEN' | 'INVALID_RESOURCE',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Authorization ヘッダーからBearer Tokenを抽出
 *
 * @param authHeader - Authorization ヘッダー（例: "Bearer eyJhbGc..."）
 * @returns 抽出されたトークン
 * @throws {OAuthError} トークンが見つからない場合
 *
 * @example
 * ```ts
 * const token = extractBearerToken(req.headers.get('Authorization'))
 * // → "eyJhbGc..."
 * ```
 */
export function extractBearerToken(authHeader: string | null): string {
  if (!authHeader) {
    throw new OAuthError('MISSING_TOKEN', 'Authorization header is missing');
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    throw new OAuthError(
      'INVALID_TOKEN',
      'Authorization header must be in "Bearer <token>" format',
    );
  }

  return match[1];
}

/**
 * Service Role Client作成（管理者操作用）
 *
 * **警告**: このクライアントはRLSをバイパスします！
 * 必ず適切な権限チェックを実装してください。
 *
 * @returns Service Role権限のSupabaseクライアント
 * @throws {Error} SERVICE_ROLE_KEY が設定されていない場合
 *
 * @example
 * ```ts
 * const adminClient = createServiceRoleClient()
 *
 * // RLSをバイパスした操作（注意！）
 * const { data } = await adminClient
 *   .from('plans')
 *   .select('*')  // すべてのユーザーのプランが取得される
 *
 * // 推奨: userId フィルタリングを明示的に実行
 * const { data } = await adminClient
 *   .from('plans')
 *   .select('*')
 *   .eq('user_id', specificUserId)
 * ```
 */
export function createServiceRoleClient(): SupabaseClient<Database> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SECRET_KEY;

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: (url, options) => {
        return fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(15_000),
        });
      },
    },
  });
}

/**
 * 認証モードの型定義
 */
export type AuthMode = 'session' | 'oauth' | 'service-role';

/**
 * 認証モード検出
 *
 * リクエストヘッダーから適切な認証モードを自動検出します。
 *
 * @param headers - リクエストヘッダー
 * @returns 検出された認証モード
 *
 * @example
 * ```ts
 * const mode = detectAuthMode(request.headers)
 * // → 'oauth' (Authorization: Bearer がある場合)
 * // → 'service-role' (X-API-Key がある場合)
 * // → 'session' (それ以外、Cookie認証)
 * ```
 */
export function detectAuthMode(headers: Headers | Record<string, string>): AuthMode {
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    return headers[name] || headers[name.toLowerCase()] || null;
  };

  // OAuth 2.1トークン認証
  const authHeader = getHeader('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return 'oauth';
  }

  // Service Role認証
  const apiKey = getHeader('X-API-Key');
  if (apiKey) {
    return 'service-role';
  }

  // デフォルト: Session Cookie認証
  return 'session';
}
