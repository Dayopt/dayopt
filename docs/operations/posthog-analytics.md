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
- PostHog の Web analytics domains には `dayopt.app`、`app.dayopt.app` と、PR #2896 の Web / Product Preview の具体的な Vercel ドメインを登録済み（2026-09-24）。ワイルドカードは使わない。SDK は米国の `https://us.i.posthog.com` を使う。別の Preview URL で検証する場合は、そのドメインを個別に登録する。
- PR #2896 の Vercel Preview ブランチには両サイトの公開 project key とブラウザ送信スイッチ、Product にはサーバー送信スイッチを設定済み。Web の `NEXT_PUBLIC_PRODUCT_ORIGIN` は対応する Product Preview を指す。本番環境にはこれらの送信スイッチを設定していない。環境変数の変更は既存デプロイに反映されないため、Preview を再デプロイしてから検証する。

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
WHERE timestamp >= toDateTime('2026-09-01 00:00:00', 'UTC')
  AND timestamp < toDateTime('2026-10-01 00:00:00', 'UTC')
  AND properties.environment = 'production'
  AND event IN ('$pageview', 'signup_cta_clicked', 'signup_completed',
                'plan_created', 'record_created', 'first_payment_succeeded')
GROUP BY event
ORDER BY event
```

Web から追跡可能な登録率の母数は同意済み Web 訪問者だけ。Product 全登録数とは同一の率に混ぜない。初回利用は登録後 24 時間以内の最初の Plan / Record 作成。翌週利用は初回利用から `[7日, 14日)` の作成または編集で、14 日観測済みの人だけを母数にする。Review の閲覧と継続の関係から因果関係は結論しない。初回支払いは `first_payment_succeeded` のみを数え、トライアルと checkout は含めない。

同意済み Product 登録者に限るファネルのテンプレート。期間と `environment` は一緒に置き換える。`observed_14d` が翌週利用率の母数で、`returned_next_week` が分子となる。PostHog SQL editor で 2026-09-24 に構文を確認したが、データは 0 件のため実データでの結果照合は未完了。

```sql
WITH
signups AS (
  SELECT distinct_id, min(timestamp) AS signup_at
  FROM events
  WHERE event = 'signup_completed'
    AND properties.environment = 'preview'
    AND timestamp >= toDateTime('2026-09-01 00:00:00', 'UTC')
    AND timestamp < toDateTime('2026-10-01 00:00:00', 'UTC')
  GROUP BY distinct_id
),
first_use AS (
  SELECT s.distinct_id, min(e.timestamp) AS first_use_at
  FROM signups AS s
  INNER JOIN events AS e ON e.distinct_id = s.distinct_id
  WHERE e.properties.environment = 'preview'
    AND e.event IN ('plan_created', 'record_created')
    AND e.timestamp >= s.signup_at
    AND e.timestamp < s.signup_at + INTERVAL 24 HOUR
  GROUP BY s.distinct_id
),
next_week AS (
  SELECT f.distinct_id
  FROM first_use AS f
  INNER JOIN events AS e ON e.distinct_id = f.distinct_id
  WHERE e.properties.environment = 'preview'
    AND e.event IN ('plan_created', 'record_created', 'plan_updated', 'record_updated')
    AND e.timestamp >= f.first_use_at + INTERVAL 7 DAY
    AND e.timestamp < f.first_use_at + INTERVAL 14 DAY
  GROUP BY f.distinct_id
),
first_paid AS (
  SELECT s.distinct_id
  FROM signups AS s
  INNER JOIN events AS e ON e.distinct_id = s.distinct_id
  WHERE e.properties.environment = 'preview'
    AND e.event = 'first_payment_succeeded'
    AND e.timestamp >= s.signup_at
  GROUP BY s.distinct_id
)
SELECT
  count(DISTINCT s.distinct_id) AS consented_signups,
  count(DISTINCT if(f.distinct_id != '', f.distinct_id, NULL)) AS first_use_within_24h,
  count(DISTINCT if(f.distinct_id != '' AND f.first_use_at <= now() - INTERVAL 14 DAY,
                    f.distinct_id, NULL)) AS observed_14d,
  count(DISTINCT if(w.distinct_id != '' AND f.first_use_at <= now() - INTERVAL 14 DAY,
                    w.distinct_id, NULL)) AS returned_next_week,
  count(DISTINCT if(p.distinct_id != '', p.distinct_id, NULL)) AS first_paid
FROM signups AS s
LEFT JOIN first_use AS f ON f.distinct_id = s.distinct_id
LEFT JOIN next_week AS w ON w.distinct_id = s.distinct_id
LEFT JOIN first_paid AS p ON p.distinct_id = s.distinct_id
```

## 保持・削除・エクスポート

PostHog Cloud の Free plan は、公式の[イベント保持規則](https://posthog.com/docs/data/events-retention)で events table の保持期間が **1 年**とされる。保持期間は削除手段ではなく、短縮もできない。Data Warehouse に別途取り込んだ表にはこの規則を適用できないため、この導入では取り込みをしない。本番送信前に管理画面の plan と法務文面を再照合する。

アカウント削除時は Dayopt の削除だけで完了とせず、Supabase user UUID を `distinct_id` とする PostHog person を特定し、person と events の削除を別途実行する。[PostHog の削除手順](https://posthog.com/docs/privacy/data-storage#data-deletion)では、Persons 画面から対象を検索して削除できる。API を使う場合は person UUID を取得し、`DELETE /api/projects/625917/persons/{person_uuid}?delete_events=true` を使う。削除には書き込み権限付き personal API key が必要なので、通常の AI 読み取り用 key と分離する。削除後の event 消去は非同期で、完了を deletion status と対象イベントの再検索で確認する。匿名 Web 履歴はアカウントに結合できた範囲だけ対象を特定できる。集計データが必要な時は PostHog SQL editor で環境と期間を限定したクエリを実行し、結果メニューの `.csv` または `.xlsx` からエクスポートする。保管先と削除期限を記録する。

## 検証と公開条件

1. Node 24 で `pnpm check`、対象 E2E、migration / RLS、同意と撤回、再送時のイベント ID を検証する。
2. Preview のテスト利用者で Web 同意 → 登録 → Product 同意 → Plan / Record → 模擬初回支払いを実行し、PostHog の raw event に自動 property や機密値がないか確認する。
3. MCP の OAuth 権限と利用可能なツールを確認し、読み取りに必要な範囲だけで AI クエリを実行する。結果・SQL・母数を照合する。
4. 本番送信は法務文面、人間のプライバシー確認、独立レビュー、送信 payload と削除手順の実測が終わってから別途承認する。

法務レビューでは、Web の日英 Privacy / Cookies に **PostHog が新しい受領者であること**、ブラウザとアカウントの同意が独立すること、送信する識別子・イベント区分、US Cloud、Free plan の 1 年保持、本人からの削除依頼時の非同期削除を反映する。現行の法的原稿は [#2833](https://github.com/Dayopt/dayopt/pull/2833) で人間レビュー待ちのため、#2875 の計測を本番で有効化する前にその正本との整合と既存の新規サブプロセッサー通知条項を判断する。原稿への追記だけで法務承認や通知済みとは扱わない。

2026-09-24 の Codex 公式 OAuth 接続試行では、`readonly=true` の URL でも認可要求に多数の write scope が含まれたため、認可を中断して設定を削除した。PostHog の `readonly=true` は公開 MCP ツールの制限で、credential 自体の権限を縮める証明ではない。AI 照合の直前に、project `625917` に限定し `Query: Read` 等だけを選んだ personal API key の権限・保存先・失効方法を確認する。現在 key は発行していない。

## 参考

- [PostHog Product Analytics と無料枠](https://posthog.com/product-analytics)
- [PostHog Web Analytics](https://posthog.com/docs/web-analytics)
- [Codex 向け PostHog MCP](https://posthog.com/docs/model-context-protocol/codex)
- [Dayopt 内部イベント](./product-analytics.md)
