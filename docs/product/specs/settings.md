---
status: current
last_verified: 2026-08-02
code: apps/product/src/features/settings
public_docs:
  - data-export
lp:
  - 'Data export'
---

# Settings（設定）

ユーザー設定全般。プロフィール、表示、データ管理、連携、課金、アカウントをカテゴリ別ページで提供する。

## 現在の振る舞い

- `/settings/[category]` のカテゴリ別ルーティング（`account` / `display` / `data` / `integrations` / `billing`）
- 連携設定では複数の Google アカウントを接続でき、取り込むカレンダーの選択、手動同期、再接続、切断を行える
- Google OAuth の callback は連携設定へ戻り、成功・失敗を通知する。未知の provider エラー詳細は表示しない
- Google 連携に必要な設定や redirect URI が現在の origin で利用できない場合、接続・再接続操作を無効にする
- iCal フィードの非公開 URL を表示・コピーできる。URL の再生成は既存 URL を即時無効にするため、確認後に行う
- 通知は独立カテゴリとして提供していない。将来追加する場合も「計画に仕える」opt-in の合図に限定し、streak 煽り・re-engagement push は作らない（[strategy.md §4-7](../../strategy.md)）
- 課金設定は Stripe Customer Portal と連携する（[Billing](./billing.md) 参照）
- データエクスポート（CSV/JSON）は体験期間・契約の終了後も利用できる（[Billing](./billing.md) の本人管理操作、2026-09-08 の決定）。CSV は先頭が `=` / `+` / `-` / `@` / tab / carriage return の値を文字列として出力し、表計算ソフトで数式として実行させない

## 関連する意思決定

- [Billing](./billing.md)
