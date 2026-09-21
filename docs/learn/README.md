# Dayopt Learning System

Dayopt で何かが起きた時に、**なぜ起きたか・どこを見るか・変えると何に影響するか**を自分で追跡できるようになるための教材。コードを暗記するためのものではない。AI が実装したものを検証し、設計の責任を持ち続けるための地図として使う。

## 使い方

```bash
pnpm learn
```

対話画面（`.learn/index.html`）が開く。画面マップで画面どうしの移り方を見て、操作を 1 つ選び、▶ で依頼がどのサービスのどの処理を通るかを辿る。各段の「⚡ ここで失敗させる」を押すと、画面・データ・再試行・痕跡がどうなり、どこから確認するかが出る。

同じ内容は、この下の Markdown を GitHub やエディタで読んでも追える。

## 中身

| 種類            | 場所                                     | 答える問い                                           |
| --------------- | ---------------------------------------- | ---------------------------------------------------- |
| 画面マップ      | [system/screens.md](system/screens.md)   | どの画面から、どの条件で、どこへ移るか               |
| 外部サービス    | [system/services.md](system/services.md) | どのサービスが止まると、何が止まり、何が動き続けるか |
| 経路（journey） | [journeys/](journeys/)                   | 1 つの操作が、ブラウザから DB まで何を通るか         |

経路（`pnpm learn` のタブと同じまとまり）:

<!-- learn:generated:start — 正本 docs/learn/journeys の JSON（journey-index） / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->

**カレンダー**

- [Plan を保存](journeys/save-plan.md) — カレンダーで時間帯をドラッグし、作成パネルでアクティビティを選ぶ。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) — カレンダー上でドラッグ・リサイズするか、Inspector で時刻・メモ・アクティビティを直す。
- [Record を作る・Plan を記録する](journeys/record-plan.md) — 終わった Plan を Inspector の「そのまま記録」で Record にする経路を中心に辿る。
- [削除と取り消し](journeys/delete-undo.md) — Plan / Record を消すと、確認ダイアログを挟まずに画面から消え、「元に戻す」付きのトーストが出る。
- [レポートを開く（集計）](journeys/report.md) — サイドバーからレポートを開くと、週 / 月 / 年の期間で Plan と Record をアクティビティ別に集計して見せる。

**アカウント**

- [ログイン（MFA 含む）](journeys/login.md) — メールアドレスとパスワードでサインインする。
- [サインアップ → ウェルカムメール](journeys/signup.md) — メールアドレスで登録し、確認メールのリンクを押す。
- [パスワードを再設定する](journeys/password-reset.md) — サインインできない人が、メールのリンクから新しいパスワードを設定する。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) — 設定からアカウントを削除する。
- [データを書き出す](journeys/data-export.md) — 設定の「データ」でエクスポートを押すと、サーバーから自分のデータを 1 回で丸ごと受け取り、期間の絞り込みと CSV への変換はブラウザで行ってファイルとして保存する。

**外部連携**

- [Google Calendar 連携](journeys/google-calendar.md) — 設定の「連携」で Google アカウントを接続し、Google の予定を Dayopt のカレンダーに取り込む。
- [Pro を契約する（課金）](journeys/billing.md) — 設定の「請求」で購入ボタンを押すと、Stripe の決済ページ（Checkout）へ移り、戻ってくる。
- [問い合わせを送る](journeys/contact.md) — ログイン中にメニューの「お問い合わせ」から送る。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) — Claude などの AI クライアントに「明日 10 時から 1 時間、集中作業の Plan を入れて」と頼むと、MCP の plans.create が呼ばれる。

**運用**

- [merge → 本番公開](journeys/deploy.md) — PR を main へ merge する。

<!-- learn:generated:end -->

## 学ぶ順序

章は概念 → 図 → 利用者の操作 → 処理 → コード の順で書いてある。コードは最後。各章の終わりに、自分で確かめる問いがある。

| #   | 章                                           | 最終的にできること                        |
| --- | -------------------------------------------- | ----------------------------------------- |
| 0   | [Dayopt とは・なぜこの設計か](00-product.md) | 「なぜこの設計なのか」を説明できる        |
| 1   | [全体アーキテクチャ](01-system-map.md)       | 各サービスの役割を説明できる              |
| 2   | [UI → DB](02-ui-to-db.md)                    | 操作がどこを通るかを追跡できる            |
| 3   | [DB / Auth / RLS](03-data-auth-rls.md)       | データの所有と境界を説明できる            |
| 4   | [Server / Client](04-server-client.md)       | Next.js のどこで動くかを判断できる        |
| 5   | [外部サービス](05-integrations.md)           | 何が止まると何が止まるかを言える          |
| 6   | [テスト](06-testing.md)                      | 何をどのテストが守っているかを説明できる  |
| 7   | [障害](07-failures.md)                       | 壊れた場所を切り分けられる                |
| 8   | [セキュリティ](08-security.md)               | 信頼境界と攻撃面を説明できる              |
| 9   | [デプロイ](09-deployment.md)                 | commit から本番までを追跡できる           |
| 10  | [API / MCP](10-api-mcp.md)                   | 外の AI から Dayopt までを追跡できる      |
| 11  | [Jev / Agent](11-agents-jev.md)              | AI が何を見て、どこで止まるかを説明できる |
| 12  | [変更](12-change.md)                         | 影響範囲を自分で判断して変更できる        |

最後に [卒業問題](graduation.md) の 7 問に、何も見ずに答える。

## 正本と生成物

- 各 .md の末尾にある `json learn:*` の block が正本。説明文と図（`learn:generated` の範囲）と対話画面は、そこから生成する
- 直す時は JSON を直し、`pnpm learn:generate` で説明文と図を作り直す。生成範囲を手で書き換えない
- コードやテストへの参照は、行番号ではなく `path` + `find`（そのファイルに含まれる文字列）で書く。`pnpm docs:check` が「ファイルが在り、文字列を含む」ことを検査する。コードを動かしたら `find` を追従させる
- 検査は参照の実在までで、説明の正しさは保証しない。コードと食い違いを見つけたら正本の JSON を直す
