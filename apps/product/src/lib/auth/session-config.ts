/**
 * セッション管理設定
 *
 * OWASP推奨のセッション管理ベストプラクティスに準拠
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
 * @see Issue #487 - OWASP準拠のセキュリティ強化 Phase 2
 */

/**
 * セッション設定（秒単位）
 */
export const SESSION_CONFIG = {
  /**
   * セッションタイムアウト（30日）
   * - 一般的なカレンダーアプリに合わせて長めに設定
   */
  maxAge: 30 * 24 * 60 * 60, // 30日

  /**
   * アイドルタイムアウト（無効）
   * - カレンダーアプリでは不要なため無効化
   * - SessionMonitorProviderはセッション失効通知用に配置
   */
  idleTimeout: 30 * 24 * 60 * 60, // 実質無効（30日）

  /**
   * 絶対タイムアウト（30日）
   * - 一般的なカレンダーアプリに合わせて長めに設定
   */
  absoluteTimeout: 30 * 24 * 60 * 60, // 30日

  /**
   * Remember Me 機能（30日間）
   * - 一般的なアプリと同等の期間
   */
  rememberMeMaxAge: 30 * 24 * 60 * 60, // 30日

  /**
   * 同時セッション数の制限（無制限）
   * - 複数デバイスでの利用を制限しない
   */
  maxConcurrentSessions: 100, // 実質無制限

  /**
   * セッション更新間隔（5分）
   * - アクティビティ検出時のセッション延長間隔
   * - 頻繁すぎるとサーバー負荷、少なすぎるとUX悪化
   */
  refreshInterval: 5 * 60, // 300秒

  /**
   * セッションID再生成のタイミング
   */
  regenerateOn: {
    login: true, // ログイン時
    logout: true, // ログアウト時
    privilegeEscalation: true, // 権限昇格時
  },
} as const;

/**
 * セッションセキュリティ設定
 */
export const SESSION_SECURITY = {
  /**
   * セッション固定攻撃対策
   * - ログイン成功時にセッションIDを再生成
   */
  preventSessionFixation: true,

  /**
   * セッションハイジャック対策
   * - User-Agent、IP addressの検証（オプション）
   */
  validateUserAgent: false, // プロキシ環境で問題になる可能性があるため無効
  validateIpAddress: false, // モバイル環境で問題になる可能性があるため無効

  /**
   * セッションタイムアウト警告
   * - タイムアウトN秒前に警告を表示
   */
  timeoutWarning: 5 * 60, // タイムアウト5分前

  /**
   * ログアウト後のリダイレクト
   */
  logoutRedirect: '/auth/login',

  /**
   * タイムアウト後のリダイレクト
   */
  timeoutRedirect: '/auth/login?reason=timeout',
} as const;
