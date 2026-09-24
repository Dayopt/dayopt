---
status: current
issue: 2875
last_verified: 2026-09-24
code:
  - packages/observability/src/posthog-browser.ts
  - apps/product/src/lib/analytics/posthog-server.ts
  - apps/product/src/features/settings/server/analytics-consent-service.ts
---

# PostHog 横断分析

Dayopt の Web 流入、登録、初回利用、初回支払いを、分析に同意した範囲で調べるための契約。プロダクト操作と課金の正本は Supabase / Stripe のままで、PostHog は欠測しうる補助データである。

## プロジェクトと送信スイッチ

- PostHog US Cloud、`Dayopt Analytics`（project ID `625917`）。Web と Product は同じプロジェクトで、`surface` と `environment` を全イベントに付ける。
- 無料枠は Product Analytics 月 100 万イベント。支払い方法を登録せず、PostHog の Usage で当月のイベント数を確認する。増え方を確認してから送信範囲を広げる。Session Replay、ヒートマップ、自動クリック、Web Vitals、例外自動取得、feature flags は使わない。
- `NEXT_PUBLIC_POSTHOG_PROJECT_KEY` は PostHog の公開 project key。`NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED=true` と `POSTHOG_SERVER_ENABLED=true` は独立した送信スイッチ。未設定なら送信しない。Preview と Production の設定・承認を分ける。
- PostHog 設定では `dayopt.app` と `app.dayopt.app` のみ許可。SDK は米国の `https://us.i.posthog.com` を使う。Preview の送信を検証する時は PostHog の許可ドメインも個別に確認する。

## 同意と識別

- Web と Product のブラウザ送信は、それぞれの origin の分析 Cookie 同意後だけ開始する。拒否・撤回するとそのブラウザからの送信を止め、SDK の識別子を reset する。Web の同意を Product に自動適用しない。
- Product の「アカウントの利用分析」はログイン済みユーザー自身が許可・撤回する。初期値は拒否。サーバーイベントは送信直前に最新値を読み、取得失敗時も送らない。Stripe webhook で別端末の支払いが成功した場合にも、このアカウントの判断を適用する。ブラウザ同意とは独立する。
- ブラウザで同意済みの Product ユーザーは Supabase user UUID で identify し、匿名 Web 訪問と同じ PostHog ブラウザ cookie を通じてつなぐ。Web と Product の両方で同意していない訪問を推定で結合しない。メール、氏名、計画タイトル、メモ、決済情報を送らない。
- `signup_completed` は登録後の認証リダイレクトで Product のブラウザ同意を得た場合だけ送る。`/auth/*` では同意バナーを表示しないため、新規利用者の `signup_viewed` は欠測しうる。登録の全数は既存の `product_events.user_signed_up` を参照する。

## イベント契約

| event                                                              | 成功境界                              | 主な追加値                                      |
| ------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `$pageview`                                                        | 同意済み Web ページ表示               | 正規化 path、外部参照元ドメイン、許可された UTM |
| `signup_cta_clicked`                                               | Web の登録 CTA                        | 固定 CTA ID、正規化 path                        |
| `signup_viewed`, `signup_completed`                                | Product の登録表示、認証完了          | 固定画面名、登録方式                            |
| `plan_created`, `record_created`, `plan_updated`, `record_updated` | DB 保存成功                           | 操作経路と件数                                  |
| `review_opened`                                                    | Review 表示                           | 固定画面名                                      |
| `app_trial_started`, `first_payment_succeeded`                     | トライアル確定、初回有料 invoice 成功 | 共通値のみ                                      |

全イベントは `schema_version=1`、`environment`、`surface` を持つ。ブラウザ SDK のイベントと property は送信前の許可リストで制限する。URL の query と hash、自由入力、Stripe ID、日付・時間帯、価格は送らない。サーバーイベントの UUID はイベント名と成功した操作の内部 ID から決定し、再送時も同じになる。PostHog が利用できなくても業務操作は成功させるため、欠測を監査ログと扱わない。

`posthog-node` 5.52.4 のローカル HTTP stub で実送信形式を展開した結果、サーバー側には SDK 由来の `$geoip_disable`、`$is_server`、`$lib`、`$lib_version` も付く。メール・URL・コンテンツは付かなかった。SDK 更新時はこの境界を再確認する。

## AI と SQL の集計規約

PostHog の SQL editor または読み取り専用の MCP クエリで、**期間を UTC の半開区間 `[start, end)`、`environment`、母数、イベント名、重複排除方法**を回答と一緒に示す。`environment` のないイベントは除外する。Production と Preview を合算しない。小さい母数では人数を伏せて共有し、個人の raw event を issue / PR / chat に貼らない。

基本的なイベント数のテンプレート。実データへの実行と HogQL 方言の確認は、Preview でイベントを送った後に行う。

```sql
SELECT event, count() AS event_count, count(DISTINCT distinct_id) AS actors
FROM events
WHERE timestamp >= toDateTime('2026-09-01 00:00:00')
  AND timestamp < toDateTime('2026-10-01 00:00:00')
  AND properties.environment = 'production'
  AND event IN ('$pageview', 'signup_cta_clicked', 'signup_completed',
                'plan_created', 'record_created', 'first_payment_succeeded')
GROUP BY event
ORDER BY event
```

Web から追跡可能な登録率の母数は同意済み Web 訪問者だけ。Product 全登録数とは同一の率に混ぜない。初回利用は登録後 24 時間以内の最初の Plan / Record 作成。翌週利用は初回利用から `[7日, 14日)` の作成または編集で、14 日観測済みの人だけを母数にする。Review の閲覧と継続の関係から因果関係は結論しない。初回支払いは `first_payment_succeeded` のみを数え、トライアルと checkout は含めない。

## 保持・削除・エクスポート

PostHog の保存期間と削除手順は本番送信前に管理画面で確認し、法務文面と一致させる。アカウント削除時は Dayopt の削除だけで完了とせず、Supabase user UUID に紐付く PostHog person / events の削除を別途実行・検証する。匿名 Web 履歴はアカウントに結合できた範囲だけ対象を特定できる。集計データが必要な時は PostHog SQL editor で環境と期間を限定してエクスポートし、保管先と削除期限を記録する。

## 検証と公開条件

1. Node 24 で `pnpm check`、対象 E2E、migration / RLS、同意と撤回、再送時のイベント ID を検証する。
2. Preview のテスト利用者で Web 同意 → 登録 → Product 同意 → Plan / Record → 模擬初回支払いを実行し、PostHog の raw event に自動 property や機密値がないか確認する。
3. MCP の OAuth 権限と利用可能なツールを確認し、読み取りに必要な範囲だけで AI クエリを実行する。結果・SQL・母数を照合する。
4. 本番送信は法務文面、人間のプライバシー確認、独立レビュー、送信 payload と削除手順の実測が終わってから別途承認する。

2026-09-24 の Codex 公式 OAuth 接続試行では、`readonly=true` の URL でも認可要求に多数の write scope が含まれたため、認可を中断して設定を削除した。PostHog の `readonly=true` は公開 MCP ツールの制限で、credential 自体の権限を縮める証明ではない。AI 照合の直前に、project `625917` に限定し `Query: Read` 等だけを選んだ personal API key の権限・保存先・失効方法を確認する。現在 key は発行していない。

## 参考

- [PostHog Product Analytics と無料枠](https://posthog.com/product-analytics)
- [PostHog Web Analytics](https://posthog.com/docs/web-analytics)
- [Codex 向け PostHog MCP](https://posthog.com/docs/model-context-protocol/codex)
- [Dayopt 内部イベント](./product-analytics.md)
