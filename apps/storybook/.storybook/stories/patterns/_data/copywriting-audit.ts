/**
 * コピーライティング トーン監査データ
 *
 * トーンルール: docs/product/copywriting.md
 * 対象: messages/ja/*.json + ハードコード文字列
 */

export type ViolationCategory =
  | 'keigo'
  | 'negative-phrasing'
  | 'error-no-recovery'
  | 'vague-placeholder'
  | 'button-suru'
  | 'generic-destructive'
  | 'hardcoded-string';

export type AuditEntry = {
  /** 翻訳ファイル名 or ソースファイルパス */
  file: string;
  /** 翻訳キー or 行番号 */
  key: string;
  /** 違反カテゴリ */
  category: ViolationCategory;
  /** 現在のテキスト */
  current: string;
  /** 修正案 */
  proposed: string;
  /** 適用ルール */
  rule: string;
};

export const CATEGORY_LABELS: Record<ViolationCategory, string> = {
  keigo: '敬語 / ます形',
  'negative-phrasing': 'ネガティブ表現',
  'error-no-recovery': 'リカバリーなしエラー',
  'vague-placeholder': '曖昧なプレースホルダー',
  'button-suru': 'ボタン「する」残り',
  'generic-destructive': '汎用 destructive ラベル',
  'hardcoded-string': 'ハードコード文字列',
};

// ---------------------------------------------------------------------------
// 敬語 / ます形 (代表例 — 全ファイル横断)
// ---------------------------------------------------------------------------
export const keigoEntries: AuditEntry[] = [
  // error.json
  {
    file: 'error.json',
    key: 'error.global.description',
    category: 'keigo',
    current: '申し訳ございません。予期しない問題が発生しました。',
    proposed: '予期しない問題が発生した',
    rule: '敬語→体言止め',
  },
  {
    file: 'error.json',
    key: 'error.boundary.description',
    category: 'keigo',
    current: '申し訳ございません。アプリケーションでエラーが発生しました。',
    proposed: 'アプリケーションでエラーが発生した',
    rule: '敬語→体言止め',
  },
  {
    file: 'error.json',
    key: 'error.boundary.autoReport',
    category: 'keigo',
    current: '自動的にエラー報告を送信いたします。',
    proposed: 'エラー報告を自動送信',
    rule: 'いたします→体言止め',
  },
  {
    file: 'error.json',
    key: 'error.notFound.description',
    category: 'keigo',
    current: 'お探しのページは存在しないか、移動された可能性があります。',
    proposed: 'このページは存在しないか、移動された可能性がある',
    rule: 'お〜ます→体言止め',
  },
  {
    file: 'error.json',
    key: 'error.inline.description',
    category: 'keigo',
    current: '問題が発生しました。もう一度お試しください。',
    proposed: '問題が起きた。もう一度試して',
    rule: 'ました＋お試しください→した＋試して',
  },

  // common.json
  {
    file: 'common.json',
    key: 'common.toast.eventDeleted',
    category: 'keigo',
    current: '予定を削除しました',
    proposed: '予定を削除した',
    rule: 'ました→た',
  },
  {
    file: 'common.json',
    key: 'common.toast.copied',
    category: 'keigo',
    current: 'コピーしました',
    proposed: 'コピーした',
    rule: 'ました→た',
  },
  {
    file: 'common.json',
    key: 'common.validation.required',
    category: 'keigo',
    current: 'この項目は必須です',
    proposed: 'この項目は必須',
    rule: 'です→体言止め',
  },
  {
    file: 'common.json',
    key: 'common.validation.invalidEmail',
    category: 'keigo',
    current: '有効なメールアドレスを入力してください',
    proposed: '有効なメールアドレスを入力',
    rule: 'してください→省略',
  },
  {
    file: 'common.json',
    key: 'common.status.offline',
    category: 'keigo',
    current: 'オフラインです。変更は接続復帰後に同期されます。',
    proposed: 'オフライン。変更は接続復帰後に同期される',
    rule: 'です/されます→体言止め',
  },
  {
    file: 'common.json',
    key: 'common.status.syncComplete',
    category: 'keigo',
    current: '同期完了しました。',
    proposed: '同期完了',
    rule: 'しました→体言止め',
  },
  {
    file: 'common.json',
    key: 'common.offline.description',
    category: 'keigo',
    current: 'インターネットに接続されていません。接続を確認してからもう一度お試しください。',
    proposed: 'インターネット未接続。接続を確認してもう一度試して',
    rule: 'されていません＋お試しください→体言止め＋試して',
  },
  {
    file: 'common.json',
    key: 'common.confirm.delete.description',
    category: 'keigo',
    current: 'この操作は取り消せません。',
    proposed: 'この操作は取り消せない',
    rule: 'ません→ない',
  },
  {
    file: 'common.json',
    key: 'common.actions.addedToPalette',
    category: 'keigo',
    current: 'パレットに追加しました',
    proposed: 'パレットに追加した',
    rule: 'ました→た',
  },
  {
    file: 'common.json',
    key: 'common.actions.removedFromPalette',
    category: 'keigo',
    current: 'パレットから解除しました',
    proposed: 'パレットから解除した',
    rule: 'ました→た',
  },
  {
    file: 'common.json',
    key: 'common.pwa.iosInstallDescription',
    category: 'keigo',
    current: 'アプリとしてインストールすると、より快適にご利用いただけます。',
    proposed: 'アプリとしてインストールすると、より快適に使える',
    rule: 'ご利用いただけます→使える',
  },

  // auth.json
  {
    file: 'auth.json',
    key: 'auth.loginForm.loginToAccount',
    category: 'keigo',
    current: 'メールアドレスとパスワードを入力してください',
    proposed: 'メールアドレスとパスワードを入力',
    rule: 'してください→省略',
  },
  {
    file: 'auth.json',
    key: 'auth.success.loginSuccess',
    category: 'keigo',
    current: 'ログインに成功しました',
    proposed: 'ログインした',
    rule: 'しました→た',
  },
  {
    file: 'auth.json',
    key: 'auth.success.resetEmailSent',
    category: 'keigo',
    current: 'パスワードリセットメールを送信しました',
    proposed: 'パスワードリセットメールを送信した',
    rule: 'しました→た',
  },
  {
    file: 'auth.json',
    key: 'auth.success.passwordUpdated',
    category: 'keigo',
    current: 'パスワードが正常に更新されました',
    proposed: 'パスワードを更新した',
    rule: 'されました→た',
  },
  {
    file: 'auth.json',
    key: 'auth.success.logoutSuccess',
    category: 'keigo',
    current: 'ログアウトしました',
    proposed: 'ログアウトした',
    rule: 'しました→た',
  },
  {
    file: 'auth.json',
    key: 'auth.success.signupSuccess',
    category: 'keigo',
    current: 'アカウントが正常に作成されました。確認メールをチェックしてください。',
    proposed: 'アカウントを作成した。確認メールをチェックして',
    rule: 'されました＋してください→た＋して',
  },
  {
    file: 'auth.json',
    key: 'auth.loginForm.agree',
    category: 'keigo',
    current: 'に同意したものとみなされます。',
    proposed: 'に同意したものとみなされる',
    rule: 'されます→される',
  },
  {
    file: 'auth.json',
    key: 'auth.passwordResetForm.enterEmail',
    category: 'keigo',
    current: 'メールアドレスを入力してください。リセット用のリンクを送信します。',
    proposed: 'メールアドレスを入力。リセット用リンクを送信する',
    rule: 'してください＋します→省略＋する',
  },
  {
    file: 'auth.json',
    key: 'auth.resetPasswordForm.description',
    category: 'keigo',
    current: 'アカウントの新しいパスワードを入力してください',
    proposed: 'アカウントの新しいパスワードを入力',
    rule: 'してください→省略',
  },
  {
    file: 'auth.json',
    key: 'auth.session.timeoutWarningDescription',
    category: 'keigo',
    current:
      'セキュリティのため、まもなく自動的にログアウトされます。続けるには「セッションを延長」をクリックしてください。',
    proposed:
      'セキュリティのため、まもなく自動ログアウトされる。続けるには「セッションを延長」をクリック',
    rule: 'されます＋してください→される＋省略',
  },
  {
    file: 'auth.json',
    key: 'auth.session.sessionExpiredDescription',
    category: 'keigo',
    current: 'セキュリティのため、セッションがタイムアウトしました。再度ログインしてください。',
    proposed: 'セッションがタイムアウトした。再度ログインして',
    rule: 'しました＋してください→た＋して',
  },
  {
    file: 'auth.json',
    key: 'auth.mfaVerify.description',
    category: 'keigo',
    current: '認証アプリの6桁のコードを入力してください',
    proposed: '認証アプリの6桁のコードを入力',
    rule: 'してください→省略',
  },

  // calendar.json
  {
    file: 'calendar.json',
    key: 'calendar.event.created',
    category: 'keigo',
    current: '予定を作成しました',
    proposed: '予定を作成した',
    rule: 'しました→た',
  },
  {
    file: 'calendar.json',
    key: 'calendar.event.updated',
    category: 'keigo',
    current: '予定を更新しました',
    proposed: '予定を更新した',
    rule: 'しました→た',
  },
  {
    file: 'calendar.json',
    key: 'calendar.event.deleted',
    category: 'keigo',
    current: '予定を削除しました',
    proposed: '予定を削除した',
    rule: 'しました→た',
  },
  {
    file: 'calendar.json',
    key: 'calendar.event.moved',
    category: 'keigo',
    current: '予定を移動しました',
    proposed: '予定を移動した',
    rule: 'しました→た',
  },
  {
    file: 'calendar.json',
    key: 'calendar.toast.syncSuccess',
    category: 'keigo',
    current: 'カレンダーを同期しました',
    proposed: 'カレンダーを同期した',
    rule: 'しました→た',
  },
  {
    file: 'calendar.json',
    key: 'calendar.error.description',
    category: 'keigo',
    current: 'ネットワーク接続を確認して、もう一度お試しください。',
    proposed: 'ネットワーク接続を確認して、もう一度試して',
    rule: 'お試しください→試して',
  },
  {
    file: 'calendar.json',
    key: 'calendar.toast.errorDescription',
    category: 'keigo',
    current: 'しばらく時間を置いてから再度お試しください',
    proposed: 'しばらく時間を置いてから再度試して',
    rule: 'お試しください→試して',
  },
  {
    file: 'calendar.json',
    key: 'calendar.toast.syncErrorDescription',
    category: 'keigo',
    current: 'ネットワーク接続を確認してください',
    proposed: 'ネットワーク接続を確認して',
    rule: 'してください→して',
  },
  {
    file: 'calendar.json',
    key: 'calendar.error.loadFailed',
    category: 'keigo',
    current: 'エントリの読み込みに失敗しました。ページを更新してください。',
    proposed: 'エントリを読み込めなかった。ページを更新して',
    rule: 'しました＋してください→た＋して',
  },

  // entry.json
  {
    file: 'entry.json',
    key: 'entry.toast.created',
    category: 'keigo',
    current: '「{title}」を作成しました',
    proposed: '「{title}」を作成した',
    rule: 'しました→た',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.updated',
    category: 'keigo',
    current: '更新しました',
    proposed: '更新した',
    rule: 'しました→た',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.deleted',
    category: 'keigo',
    current: '削除しました',
    proposed: '削除した',
    rule: 'しました→た',
  },
  {
    file: 'entry.json',
    key: 'entry.delete.description',
    category: 'keigo',
    current: 'この操作は取り消せません。エントリーは完全に削除され、カレンダーからも削除されます。',
    proposed: 'この操作は取り消せない。エントリーは完全に削除され、カレンダーからも消える',
    rule: 'ません＋されます→ない＋体言止め',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.conflict',
    category: 'keigo',
    current: 'このエントリは他の場所で変更されています。最新データをリロードしてください。',
    proposed: 'このエントリは他の場所で変更された。最新データをリロードして',
    rule: 'されています＋してください→された＋して',
  },

  // notification.json
  {
    file: 'notification.json',
    key: 'notification.settings.browserNotifications.description',
    category: 'keigo',
    current: 'リマインダー時にブラウザ通知を表示',
    proposed: 'リマインダー時にブラウザ通知を表示',
    rule: 'OK（既に体言止め）',
  },
  {
    file: 'notification.json',
    key: 'notification.settings.tip',
    category: 'keigo',
    current:
      'ブラウザ通知はアプリを開いている時のみ動作します。メール通知やプッシュ通知を有効にすると、いつでも通知を受け取れます。',
    proposed:
      'ブラウザ通知はアプリを開いている時のみ動作する。メール通知やプッシュ通知を有効にすると、いつでも通知を受け取れる',
    rule: 'します＋れます→する＋れる',
  },

  // tags.json
  {
    file: 'tags.json',
    key: 'tags.page.tagCreated',
    category: 'keigo',
    current: 'タグ「{name}」を作成しました',
    proposed: 'タグ「{name}」を作成した',
    rule: 'しました→た',
  },
  {
    file: 'tags.json',
    key: 'tags.page.tagArchived',
    category: 'keigo',
    current: 'タグ「{name}」をアーカイブしました',
    proposed: 'タグ「{name}」をアーカイブした',
    rule: 'しました→た',
  },
  {
    file: 'tags.json',
    key: 'tags.page.tagDeleted',
    category: 'keigo',
    current: 'タグ「{name}」を完全に削除しました',
    proposed: 'タグ「{name}」を完全に削除した',
    rule: 'しました→た',
  },
  {
    file: 'tags.json',
    key: 'tags.modal.createDescription',
    category: 'keigo',
    current: '新しいタグを作成します',
    proposed: '新しいタグを作成',
    rule: 'します→体言止め',
  },
  {
    file: 'tags.json',
    key: 'tags.delete.description',
    category: 'keigo',
    current:
      'このタグを削除すると、関連するすべてのアイテムからタグが外されます。この操作は取り消せません。',
    proposed:
      'このタグを削除すると、関連するすべてのアイテムからタグが外される。この操作は取り消せない',
    rule: 'されます＋ません→される＋ない',
  },

  // settings.json
  {
    file: 'settings.json',
    key: 'settings.account.profileUpdated',
    category: 'keigo',
    current: 'プロフィールを更新しました',
    proposed: 'プロフィールを更新した',
    rule: 'しました→た',
  },
  {
    file: 'settings.json',
    key: 'settings.account.passwordUpdated',
    category: 'keigo',
    current: 'パスワードを更新しました',
    proposed: 'パスワードを更新した',
    rule: 'しました→た',
  },
  {
    file: 'settings.json',
    key: 'settings.account.displayNameDesc',
    category: 'keigo',
    current: '他のユーザーに表示される名前',
    proposed: '他のユーザーに表示される名前',
    rule: 'OK（既に体言止め）',
  },
  {
    file: 'settings.json',
    key: 'settings.account.emailChange.description',
    category: 'keigo',
    current: '新しいメールアドレスとパスワードを入力してください',
    proposed: '新しいメールアドレスとパスワードを入力',
    rule: 'してください→省略',
  },
  {
    file: 'settings.json',
    key: 'settings.account.emailChange.successHint',
    category: 'keigo',
    current: 'メール内のリンクをクリックして、メールアドレスの変更を完了してください。',
    proposed: 'メール内のリンクをクリックして変更を完了して',
    rule: 'してください→して',
  },
  {
    file: 'settings.json',
    key: 'settings.account.twoFactorProtection',
    category: 'keigo',
    current: 'アカウントが追加のセキュリティ層で保護されています。',
    proposed: 'アカウントが追加のセキュリティ層で保護されている',
    rule: 'されています→されている',
  },
  {
    file: 'settings.json',
    key: 'settings.account.emailUsedFor',
    category: 'keigo',
    current: 'ログインや通知に使用されます',
    proposed: 'ログインや通知に使用',
    rule: 'されます→体言止め',
  },
  {
    file: 'settings.json',
    key: 'settings.aiStyle.description',
    category: 'keigo',
    current: 'チャットパネルでAIがどのようにコミュニケーションするかを選んでください。',
    proposed: 'チャットパネルでのAIコミュニケーションスタイルを選択',
    rule: 'てください→体言止め',
  },
  {
    file: 'settings.json',
    key: 'settings.dataControls.export.description',
    category: 'keigo',
    current: '選択した形式でデータをダウンロードします。',
    proposed: '選択した形式でデータをダウンロード',
    rule: 'します→体言止め',
  },
  {
    file: 'settings.json',
    key: 'settings.dataControls.restore.warning',
    category: 'keigo',
    current: '復元すると既存のデータが上書きされます。この操作は取り消せません。',
    proposed: '復元すると既存のデータが上書きされる。この操作は取り消せない',
    rule: 'されます＋ません→される＋ない',
  },

  // contact.json
  {
    file: 'contact.json',
    key: 'contact.submitSuccess',
    category: 'keigo',
    current: 'メッセージが送信されました。ありがとうございます！',
    proposed: 'メッセージを送信した',
    rule: 'されました＋ございます→た',
  },
  {
    file: 'contact.json',
    key: 'contact.submitError',
    category: 'keigo',
    current: 'メッセージの送信に失敗しました。もう一度お試しください。',
    proposed: 'メッセージを送信できなかった。もう一度試して',
    rule: 'しました＋お試しください→た＋試して',
  },
  {
    file: 'contact.json',
    key: 'contact.rateLimited',
    category: 'keigo',
    current: 'メッセージの送信回数が上限に達しました。しばらくしてからお試しください。',
    proposed: '送信回数が上限に達した。しばらくしてから試して',
    rule: 'しました＋お試しください→た＋試して',
  },

  // navigation.json
  {
    file: 'navigation.json',
    key: 'navigation.navUser.logoutSuccess',
    category: 'keigo',
    current: 'ログアウトしました',
    proposed: 'ログアウトした',
    rule: 'しました→た',
  },

  // onboarding.json
  {
    file: 'onboarding.json',
    key: 'onboarding.error.completeFailed',
    category: 'keigo',
    current: '保存に失敗しました。もう一度お試しください。',
    proposed: '保存できなかった。もう一度試して',
    rule: 'しました＋お試しください→た＋試して',
  },
  {
    file: 'onboarding.json',
    key: 'onboarding.error.sessionExpired',
    category: 'keigo',
    current: 'セッションが切れました。再ログインしてください。',
    proposed: 'セッションが切れた。再ログインして',
    rule: 'ました＋してください→た＋して',
  },
  {
    file: 'onboarding.json',
    key: 'onboarding.error.networkError',
    category: 'keigo',
    current: 'ネットワークに接続できません。接続を確認してください。',
    proposed: 'ネットワークに接続できない。接続を確認して',
    rule: 'ません＋してください→ない＋して',
  },
];

// ---------------------------------------------------------------------------
// ネガティブ表現
// ---------------------------------------------------------------------------
export const negativePhrasing: AuditEntry[] = [
  {
    file: 'common.json',
    key: 'common.noData',
    category: 'negative-phrasing',
    current: 'データがありません',
    proposed: 'まだデータがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'common.json',
    key: 'common.search.noResults',
    category: 'negative-phrasing',
    current: '見つかりませんでした',
    proposed: '一致する結果がない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'common.json',
    key: 'common.insights.noRecords',
    category: 'negative-phrasing',
    current: 'この週の記録はありません。',
    proposed: 'この週の記録はまだない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'common.json',
    key: 'common.suggest.noResults',
    category: 'negative-phrasing',
    current: '候補なし',
    proposed: '一致する候補がない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'notification.json',
    key: 'notification.empty.all',
    category: 'negative-phrasing',
    current: '通知はありません',
    proposed: 'まだ通知がない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'notification.json',
    key: 'notification.empty.unread',
    category: 'negative-phrasing',
    current: '未読の通知はありません',
    proposed: '未読の通知はない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'notification.json',
    key: 'notification.empty.reminders',
    category: 'negative-phrasing',
    current: 'リマインダー通知はありません',
    proposed: 'リマインダー通知はない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'notification.json',
    key: 'notification.empty.ai',
    category: 'negative-phrasing',
    current: 'AI通知はありません',
    proposed: 'AI通知はない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'calendar.json',
    key: 'calendar.event.noEventsOnThisDay',
    category: 'negative-phrasing',
    current: 'この日にはイベントがありません',
    proposed: 'この日はまだ予定がない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'calendar.json',
    key: 'calendar.stats.emptyTitle',
    category: 'negative-phrasing',
    current: '今週のデータがありません',
    proposed: '今週の記録はまだない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'calendar.json',
    key: 'calendar.stats.emptyDescription',
    category: 'negative-phrasing',
    current: 'エントリーを追加して進捗を確認しましょう',
    proposed: 'エントリーを追加して進捗を確認',
    rule: 'しましょう→体言止め',
  },
  {
    file: 'calendar.json',
    key: 'calendar.stats.noTagData',
    category: 'negative-phrasing',
    current: 'この期間のタグデータがありません',
    proposed: 'この期間のタグデータはまだない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'tags.json',
    key: 'tags.page.noTags',
    category: 'negative-phrasing',
    current: 'タグがありません',
    proposed: 'まだタグがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'tags.json',
    key: 'tags.search.noTags',
    category: 'negative-phrasing',
    current: 'タグが見つかりません',
    proposed: '一致するタグがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'tags.json',
    key: 'tags.messages.noTagsYet',
    category: 'negative-phrasing',
    current: 'タグがまだありません',
    proposed: 'まだタグがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'tags.json',
    key: 'tags.settings.noGroups',
    category: 'negative-phrasing',
    current: 'グループがありません',
    proposed: 'まだグループがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'entry.json',
    key: 'entry.inspector.notFound',
    category: 'negative-phrasing',
    current: 'エントリーが見つかりません',
    proposed: 'エントリーが見つからない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'entry.json',
    key: 'entry.inspector.records.noMatch',
    category: 'negative-phrasing',
    current: '一致するエントリーがありません',
    proposed: '一致するエントリーがない',
    rule: 'ポジティブ変換',
  },
  {
    file: 'settings.json',
    key: 'settings.activity.noActivity',
    category: 'negative-phrasing',
    current: 'まだアクティビティがありません',
    proposed: 'まだアクティビティがない',
    rule: 'ポジティブ変換',
  },
];

// ---------------------------------------------------------------------------
// リカバリーなしエラー（代表例）
// ---------------------------------------------------------------------------
export const errorNoRecovery: AuditEntry[] = [
  {
    file: 'common.json',
    key: 'common.errors.generic',
    category: 'error-no-recovery',
    current: 'エラーが発生しました',
    proposed: '問題が起きた。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'common.json',
    key: 'common.toast.copyFailed',
    category: 'error-no-recovery',
    current: 'コピーに失敗しました',
    proposed: 'コピーできなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'common.json',
    key: 'common.errors.storage.uploadFailed',
    category: 'error-no-recovery',
    current: 'アップロードに失敗しました',
    proposed: 'アップロードできなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'common.json',
    key: 'common.errors.storage.deleteFailed',
    category: 'error-no-recovery',
    current: '削除に失敗しました',
    proposed: '削除できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'common.json',
    key: 'common.suggest.loadError',
    category: 'error-no-recovery',
    current: '読み込みに失敗しました',
    proposed: '読み込めなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'tags.json',
    key: 'tags.errors.createFailed',
    category: 'error-no-recovery',
    current: 'タグの作成に失敗しました',
    proposed: 'タグを作成できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'tags.json',
    key: 'tags.errors.updateFailed',
    category: 'error-no-recovery',
    current: 'タグの更新に失敗しました',
    proposed: 'タグを更新できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'tags.json',
    key: 'tags.errors.deleteFailed',
    category: 'error-no-recovery',
    current: 'タグの削除に失敗しました',
    proposed: 'タグを削除できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'tags.json',
    key: 'tags.toast.groupCreateFailed',
    category: 'error-no-recovery',
    current: 'グループの作成に失敗しました',
    proposed: 'グループを作成できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'calendar.json',
    key: 'calendar.toast.error',
    category: 'error-no-recovery',
    current: '操作に失敗しました',
    proposed: '操作できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'calendar.json',
    key: 'calendar.errors.loadFailed',
    category: 'error-no-recovery',
    current: 'カレンダーの読み込みに失敗しました',
    proposed: 'カレンダーを読み込めなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.createFailed',
    category: 'error-no-recovery',
    current: '作成に失敗しました: {error}',
    proposed: '作成できなかった: {error}',
    rule: 'リカバリー追加（エラー詳細あり）',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.updateFailed',
    category: 'error-no-recovery',
    current: '更新に失敗しました',
    proposed: '更新できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'entry.json',
    key: 'entry.toast.deleteFailed',
    category: 'error-no-recovery',
    current: '削除に失敗しました: {error}',
    proposed: '削除できなかった: {error}',
    rule: 'リカバリー追加（エラー詳細あり）',
  },
  {
    file: 'settings.json',
    key: 'settings.common.saveFailed',
    category: 'error-no-recovery',
    current: '保存に失敗しました',
    proposed: '保存できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'settings.json',
    key: 'settings.account.passwordUpdateFailed',
    category: 'error-no-recovery',
    current: 'パスワードの更新に失敗しました',
    proposed: 'パスワードを更新できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'notification.json',
    key: 'notification.error.title',
    category: 'error-no-recovery',
    current: '通知の読み込みに失敗しました',
    proposed: '通知を読み込めなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'navigation.json',
    key: 'navigation.navUser.logoutFailed',
    category: 'error-no-recovery',
    current: 'ログアウトに失敗しました',
    proposed: 'ログアウトできなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'sidebar.json',
    key: 'sidebar.palette.pinFailed',
    category: 'error-no-recovery',
    current: 'ピン留めに失敗しました',
    proposed: 'ピン留めできなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'sidebar.json',
    key: 'sidebar.palette.unpinFailed',
    category: 'error-no-recovery',
    current: 'ピン解除に失敗しました',
    proposed: 'ピン解除できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
  {
    file: 'sidebar.json',
    key: 'sidebar.palette.updateFailed',
    category: 'error-no-recovery',
    current: '更新に失敗しました',
    proposed: '更新できなかった。もう一度試して',
    rule: 'リカバリー追加',
  },
];

// ---------------------------------------------------------------------------
// 曖昧なプレースホルダー
// ---------------------------------------------------------------------------
export const vaguePlaceholders: AuditEntry[] = [
  {
    file: 'settings.json',
    key: 'settings.account.displayNamePlaceholder',
    category: 'vague-placeholder',
    current: '表示名を入力',
    proposed: '例: Taro',
    rule: '入力例を示す',
  },
  {
    file: 'contact.json',
    key: 'contact.message.placeholder',
    category: 'vague-placeholder',
    current: 'メッセージを入力...',
    proposed: '例: ボタンが反応しない',
    rule: '入力例を示す',
  },
  {
    file: 'tags.json',
    key: 'tags.form.namePlaceholder',
    category: 'vague-placeholder',
    current: 'タグ名を入力',
    proposed: '例: 仕事、勉強',
    rule: '入力例を示す',
  },
  {
    file: 'tags.json',
    key: 'tags.form.descriptionPlaceholder',
    category: 'vague-placeholder',
    current: 'このタグの用途や説明を入力...',
    proposed: '例: クライアントワーク全般',
    rule: '入力例を示す',
  },
  {
    file: 'tags.json',
    key: 'tags.inspector.namePlaceholder',
    category: 'vague-placeholder',
    current: 'タグ名を入力...',
    proposed: '例: 集中作業',
    rule: '入力例を示す',
  },
  {
    file: 'tags.json',
    key: 'tags.inspector.addDescription',
    category: 'vague-placeholder',
    current: '説明を追加...',
    proposed: '例: 朝のディープワーク',
    rule: '入力例を示す',
  },
  {
    file: 'common.json',
    key: 'common.search.placeholder',
    category: 'vague-placeholder',
    current: '検索...',
    proposed: '例: ミーティング、運動',
    rule: '入力例を示す',
  },
  {
    file: 'entry.json',
    key: 'entry.inspector.note.placeholder',
    category: 'vague-placeholder',
    current: 'メモを追加...',
    proposed: '例: 集中できた',
    rule: '入力例を示す',
  },
  {
    file: 'entry.json',
    key: 'entry.inspector.addDescriptionPlaceholder',
    category: 'vague-placeholder',
    current: '説明を追加...',
    proposed: '例: Slack整理 + メール返信',
    rule: '入力例を示す',
  },
  {
    file: 'settings.json',
    key: 'settings.aiStyle.customPromptPlaceholder',
    category: 'vague-placeholder',
    current: 'AIにどのようにコミュニケーションしてほしいか書いてください...',
    proposed: '例: 箇条書きで簡潔に、絵文字は使わず',
    rule: '入力例を示す',
  },
  {
    file: 'onboarding.json',
    key: 'onboarding.welcome.namePlaceholder',
    category: 'vague-placeholder',
    current: '名前を入力',
    proposed: '例: Taro',
    rule: '入力例を示す',
  },
];

// ---------------------------------------------------------------------------
// ボタン「する」残り
// ---------------------------------------------------------------------------
export const buttonSuru: AuditEntry[] = [
  {
    file: 'notification.json',
    key: 'notification.actions.markAllAsRead',
    category: 'button-suru',
    current: 'すべて既読にする',
    proposed: 'すべて既読に',
    rule: '「する」省略',
  },
  {
    file: 'entry.json',
    key: 'entry.inspector.menu.duplicate',
    category: 'button-suru',
    current: '複製する',
    proposed: '複製',
    rule: '「する」省略',
  },
  {
    file: 'calendar.json',
    key: 'calendar.filter.mergeTag.confirm',
    category: 'button-suru',
    current: '統合する',
    proposed: '統合',
    rule: '「する」省略',
  },
  {
    file: 'tags.json',
    key: 'tags.merge.confirm',
    category: 'button-suru',
    current: '統合する',
    proposed: '統合',
    rule: '「する」省略',
  },
  {
    file: 'tags.json',
    key: 'tags.delete.confirmButton',
    category: 'button-suru',
    current: '削除する',
    proposed: '削除',
    rule: '「する」省略',
  },
];

// ---------------------------------------------------------------------------
// 汎用 destructive ラベル
// ---------------------------------------------------------------------------
export const genericDestructive: AuditEntry[] = [
  {
    file: 'calendar.json',
    key: 'calendar.contextMenu.delete',
    category: 'generic-destructive',
    current: '削除',
    proposed: 'エントリーを削除',
    rule: 'destructive は対象を明記',
  },
  {
    file: 'entry.json',
    key: 'entry.view.delete',
    category: 'generic-destructive',
    current: '削除',
    proposed: 'エントリーを削除',
    rule: 'destructive は対象を明記',
  },
  {
    file: 'tags.json',
    key: 'tags.page.delete',
    category: 'generic-destructive',
    current: '削除',
    proposed: 'タグを削除',
    rule: 'destructive は対象を明記',
  },
  {
    file: 'notification.json',
    key: 'notification.deleteNotification',
    category: 'generic-destructive',
    current: '通知を削除',
    proposed: '通知を削除',
    rule: 'OK（既に対象明記）',
  },
];

// ---------------------------------------------------------------------------
// ハードコード文字列
// ---------------------------------------------------------------------------
export const hardcodedStrings: AuditEntry[] = [
  {
    file: 'src/app/[locale]/(auth)/auth/mfa-verify/page.tsx',
    key: 'L51',
    category: 'hardcoded-string',
    current: 'MFAチャレンジの作成に失敗しました',
    proposed: '認証コードの準備に失敗した。もう一度試して',
    rule: '専門用語→平易 + リカバリー追加',
  },
  {
    file: 'src/app/[locale]/(auth)/auth/mfa-verify/page.tsx',
    key: 'L65',
    category: 'hardcoded-string',
    current: 'MFA状態の確認に失敗しました',
    proposed: '認証状態を確認できなかった。もう一度試して',
    rule: '専門用語→平易 + リカバリー追加',
  },
  {
    file: 'src/app/[locale]/(auth)/auth/mfa-verify/page.tsx',
    key: 'L71',
    category: 'hardcoded-string',
    current: '6桁のコードを入力してください',
    proposed: '6桁のコードを入力',
    rule: 'してください→省略',
  },
  {
    file: 'src/app/[locale]/(auth)/auth/mfa-verify/page.tsx',
    key: 'L99',
    category: 'hardcoded-string',
    current: '無効なコードです。もう一度お試しください',
    proposed: '無効なコード。もう一度試して',
    rule: 'です＋お試しください→体言止め＋試して',
  },
  {
    file: 'src/features/auth/schemas/auth.schema.ts',
    key: 'L9',
    category: 'hardcoded-string',
    current: 'メールアドレスを入力してください',
    proposed: 'メールアドレスを入力',
    rule: 'してください→省略',
  },
  {
    file: 'src/features/auth/schemas/auth.schema.ts',
    key: 'L11',
    category: 'hardcoded-string',
    current: 'パスワードを入力してください',
    proposed: 'パスワードを入力',
    rule: 'してください→省略',
  },
  {
    file: 'src/features/entry/server/entry-service.ts',
    key: 'L204',
    category: 'hardcoded-string',
    current: 'この時間帯には既にエントリがあります（{count}件）',
    proposed: 'この時間帯には既にエントリがある（{count}件）',
    rule: 'あります→ある',
  },
  {
    file: 'src/features/entry/server/entry-service.ts',
    key: 'L249',
    category: 'hardcoded-string',
    current: 'このエントリは他の場所で更新されています。最新データをリロードしてください。',
    proposed: 'このエントリは他の場所で更新された。最新データをリロードして',
    rule: 'されています＋してください→された＋して',
  },
  {
    file: 'src/platform/supabase/storage.ts',
    key: 'L70',
    category: 'hardcoded-string',
    current: '画像ファイルのみアップロード可能です',
    proposed: '画像ファイルのみアップロード可能',
    rule: 'です→体言止め',
  },
  {
    file: 'src/platform/supabase/storage.ts',
    key: 'L82',
    category: 'hardcoded-string',
    current: 'ファイルサイズは5MB以下にしてください',
    proposed: 'ファイルサイズは5MB以下',
    rule: 'してください→体言止め',
  },
  {
    file: 'src/platform/trpc/procedures.ts',
    key: 'L241',
    category: 'hardcoded-string',
    current: 'サーバーエラーが発生しました',
    proposed: 'サーバーエラーが発生した。もう一度試して',
    rule: 'しました→た＋リカバリー追加',
  },
];

// ---------------------------------------------------------------------------
// 全エントリ集約
// ---------------------------------------------------------------------------
export const allEntries: AuditEntry[] = [
  ...keigoEntries,
  ...negativePhrasing,
  ...errorNoRecovery,
  ...vaguePlaceholders,
  ...buttonSuru,
  ...genericDestructive,
  ...hardcodedStrings,
];

/**
 * カテゴリ別にグループ化して返す
 */
export function getEntriesByCategory(): Record<ViolationCategory, AuditEntry[]> {
  return {
    keigo: keigoEntries,
    'negative-phrasing': negativePhrasing,
    'error-no-recovery': errorNoRecovery,
    'vague-placeholder': vaguePlaceholders,
    'button-suru': buttonSuru,
    'generic-destructive': genericDestructive,
    'hardcoded-string': hardcodedStrings,
  };
}
