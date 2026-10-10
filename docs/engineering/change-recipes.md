---
status: current
last_verified: 2026-10-10
---

# 定型変更レシピ台帳

定型の変更作業（「カテゴリ色を 1 つ足す」など）ごとに、触る場所と、その手順を誰が保証しているかを記録する台帳。[#3089](https://github.com/Dayopt/dayopt/issues/3089) の測定基盤で、目標は全レシピの **手動** 手順を 0 にすること。

この台帳は 2026-10-10 時点の現状記録であり、作業手順書として読む前に該当レシピの最終確認日と実コードを照合する。機械化を進めた PR は同じ変更で該当行の分類を更新する。

## 分類

| 分類     | 意味                                                                          | 実行者に要る知識 |
| -------- | ----------------------------------------------------------------------------- | ---------------- |
| 入口     | そのレシピで最初に編集する 1 箇所（正本）                                     | レシピ名だけ     |
| 導出     | 正本から型・値が派生するため、手順そのものが無い                              | 不要             |
| 生成     | 生成コマンドが書き、`--check` が CI で差分を検出する                          | 不要             |
| 検査     | 漏れると型エラー・test・CI が失敗し、エラー文から修正箇所が分かる             | 不要             |
| 手動     | 漏れても何も失敗しない、または失敗しても修正箇所が分からない                  | **背景知識**     |
| 人間判断 | repo の外が正本、または製品判断が要る。検査が CHECKPOINT として明示して止まる | 判断権限         |

「検査」でも片方向しか見ていないものは、見ていない側を手動として数える。

## 集計

| #   | レシピ                     | 手動 | 人間判断 |
| --- | -------------------------- | ---- | -------- |
| 1   | カテゴリ色を追加           | 5    | 0        |
| 2   | user_settings の選択肢追加 | 4    | 0        |
| 3   | locale を追加              | 6    | 0        |
| 4   | OAuth client を追加        | 4    | 0        |
| 5   | MCP tool を追加            | 3    | 0        |
| 6   | cron job を追加            | 4    | 0        |
| 7   | サービスエラーコードを追加 | 3    | 0        |
| 8   | DT エラーコードを追加      | 3    | 0        |
| 9   | Stripe webhook event 追加  | 2    | 1        |
| 10  | env を追加                 | 3    | 1        |
| 11  | ページを追加               | 2    | 0        |
| 12  | feature を追加             | 2    | 0        |
| 13  | i18n namespace を追加      | 4    | 0        |
| 14  | 価格・トライアル日数を変更 | 4    | 1        |
| 15  | Node のメジャー更新        | 2    | 0        |
|     | **合計**                   | 51   | 3        |

## レシピ

パスは `apps/product/src/` 配下を `src/` と略す。

### 1. カテゴリ色を追加

| 手順               | 場所                                                                                 | 分類 | 担保 |
| ------------------ | ------------------------------------------------------------------------------------ | ---- | ---- |
| 色名を足す         | `src/features/activities/lib/category-colors.ts`（`CATEGORY_COLOR_NAMES`）           | 入口 | —    |
| tRPC 入力の enum   | `src/features/activities/server/router.ts`（`CATEGORY_COLOR`）                       | 手動 | なし |
| service の色リスト | `src/features/activities/server/activities-mutation-service.ts`（`CATEGORY_COLORS`） | 手動 | なし |
| DB CHECK           | 新 migration で `categories_color_valid` を再作成                                    | 手動 | なし |
| 色トークン         | `packages/foundations/src/tokens/colors.css`（`--category-*`）                       | 手動 | なし |
| Tailwind 対応      | `packages/foundations/src/tailwind-theme.css`（`--color-category-*`）                | 手動 | なし |

### 2. user_settings の選択肢を追加

| 手順                | 場所                                                             | 分類 | 担保 |
| ------------------- | ---------------------------------------------------------------- | ---- | ---- |
| 値を足す            | `src/lib/time/user-preference.ts`                                | 入口 | —    |
| tRPC 入力の enum    | `src/features/settings/server/router.ts`                         | 手動 | なし |
| service の型と cast | `src/features/settings/server/settings-service.ts`               | 手動 | なし |
| DB CHECK            | 新 migration で `user_settings` の該当 CHECK を再作成            | 手動 | なし |
| 設定 UI と文言      | `src/features/settings/components/*`、`messages/*/settings.json` | 手動 | なし |

### 3. locale を追加

| 手順                       | 場所                                                                                                                     | 分類 | 担保                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------- |
| locale を足す              | `packages/config/src/i18n.ts`（`SUPPORTED_LOCALES`）                                                                     | 入口 | —                                                         |
| messages ディレクトリ      | `apps/product/messages/<locale>/`                                                                                        | 生成 | `scripts/tasks/add-locale.ts`（案内文のパスが現存しない） |
| 検査 script の locale 一覧 | `scripts/tasks/check-i18n-integrity.ts`、`check-glossary.ts`、`docs-coverage/collect.ts`、`scripts/lib/glossary/core.ts` | 手動 | なし                                                      |
| web docs の locale 分岐    | `apps/web/src/app/[locale]/(docs)/docs/[...slug]/page.tsx`                                                               | 手動 | なし                                                      |
| Storybook mock             | `apps/storybook/.storybook/mocks/next-intl-*`                                                                            | 手動 | なし                                                      |
| analytics の locale        | `packages/observability/src/posthog-capture.ts`                                                                          | 手動 | なし                                                      |
| 認証メール                 | `supabase/functions/send-auth-email/`（`type Locale`、6 ファイル）                                                       | 手動 | なし                                                      |
| DB CHECK                   | 新 migration で `preferred_locale` の CHECK を再作成                                                                     | 手動 | なし                                                      |

### 4. OAuth client を追加

| 手順                  | 場所                                                                              | 分類 | 担保                            |
| --------------------- | --------------------------------------------------------------------------------- | ---- | ------------------------------- |
| client id を足す      | `src/lib/oauth-server/redirect-uris.ts`（`OAuthClientId`）                        | 入口 | —                               |
| client 定義・追加 URI | `src/lib/oauth-server/clients.ts`                                                 | 検査 | `Record<OAuthClientId, …>` の型 |
| redirect URI の env   | `src/env.ts`                                                                      | 手動 | なし                            |
| env 一覧              | `scripts/tasks/env/schema.ts`                                                     | 手動 | なし                            |
| DB CHECK と SQL 関数  | 新 migration で client_id CHECK（4 制約）と関数内の配列を更新                     | 手動 | なし                            |
| 設定画面の表示名      | `src/features/settings/components/McpConnectionsSettings.tsx`（`clientLabelFor`） | 手動 | なし（`default` で生値表示）    |

### 5. MCP tool を追加

| 手順                    | 場所                                                                     | 分類 | 担保                                            |
| ----------------------- | ------------------------------------------------------------------------ | ---- | ----------------------------------------------- |
| tool を定義する         | `src/app/api/mcp/_tools/registry.ts`（`MCP_TOOL_DESCRIPTORS`）           | 入口 | —                                               |
| 出力契約                | `src/app/api/mcp/_tools/__snapshots__/`                                  | 検査 | `contract-snapshot.test.ts`                     |
| 構成図・system surface  | `docs/engineering/data/system-surface.md` ほか                           | 生成 | `pnpm architecture:check`                       |
| read tool の scope 判定 | `src/lib/trpc/procedures.ts`（`MCP_TRPC_SCOPE_REQUIREMENTS`）            | 手動 | なし（漏れると実行時 403）                      |
| 新 scope の DB 許可     | `private.oauth_supported_scopes_v1()`                                    | 検査 | `mcp-oauth-scope-allowlist.integration.test.ts` |
| scope の表示名          | `messages/*/oauth.json`、`McpConnectionsSettings.tsx`（`scopeLabelFor`） | 手動 | なし（`default` で生値表示）                    |
| 公開 docs               | `apps/web/content/docs/{en,ja}/data/api-mcp.mdx`                         | 手動 | なし（`docs-audit` skill は手動起動）           |

### 6. cron job を追加

| 手順               | 場所                                                                        | 分類 | 担保                                                            |
| ------------------ | --------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| 監視上限を足す     | `src/lib/ops/cron-heartbeat-policy.mjs`（`JOB_MAX_AGE_MINUTES`）            | 入口 | —                                                               |
| route を実装       | `src/app/api/cron/<job>/route.ts`                                           | 検査 | `src/app/route-duration-contract.test.ts`（route 全走査）       |
| CRON_SECRET の照合 | 同 route（既存 route からの複製）                                           | 手動 | なし                                                            |
| スケジュール       | `apps/product/vercel.json`（`crons`）                                       | 手動 | なし                                                            |
| job 名の型         | `src/lib/ops/cron-heartbeat.ts`（`CronJob`）、`cron-heartbeat-policy.d.mts` | 手動 | なし                                                            |
| DB CHECK           | 新 migration で `cron_heartbeats_job_name_check` を再作成                   | 検査 | `cron-heartbeat.integration.test.ts`（policy ⊆ CHECK の片方向） |
| DB test            | `supabase/tests/cron-heartbeats.sql`                                        | 手動 | なし                                                            |

### 7. サービスエラーコードを追加

| 手順                  | 場所                                       | 分類 | 担保                                |
| --------------------- | ------------------------------------------ | ---- | ----------------------------------- |
| service で throw する | 各 `*-service.ts`                          | 入口 | —                                   |
| tRPC code への対応    | `src/lib/trpc/error-code-map.ts`           | 手動 | なし（漏れると 500 と Sentry 報告） |
| client に見せるか     | `src/lib/trpc/client-safe-service-code.ts` | 手動 | なし                                |
| UI の分岐と文言       | 呼び出し側 component、`messages/*`         | 手動 | なし                                |

### 8. DT エラーコードを追加

| 手順                  | 場所                                                            | 分類 | 担保                                                                     |
| --------------------- | --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| SQL で raise する     | 新 migration（`USING ERRCODE = 'DTxxx'`）                       | 入口 | —                                                                        |
| UI 経路の対応表と文言 | `src/features/timeblock/server/timeblock-command-client.ts`     | 手動 | なし                                                                     |
| MCP 経路の対応表      | `src/features/timeblock/server/mcp-mutation-client.ts`          | 手動 | なし（2 表は既に DT001 / DT002 で不一致）                                |
| tRPC の許可リスト     | `src/lib/trpc/error-code-map.ts`、`client-safe-service-code.ts` | 手動 | なし                                                                     |
| 不変条件の写し表      | `docs/engineering/invariants.md`                                | 検査 | `pnpm architecture:check`（docs と code の一致のみ。SQL とは照合しない） |

### 9. Stripe webhook event を追加

| 手順              | 場所                                                                                       | 分類     | 担保 |
| ----------------- | ------------------------------------------------------------------------------------------ | -------- | ---- |
| handler を足す    | `src/app/api/webhooks/stripe/route.ts`（`switch (event.type)`）                            | 入口     | —    |
| 再照合の対象      | `src/features/settings/server/billing-webhook-reconciliation.ts`（`RELEVANT_EVENT_TYPES`） | 手動     | なし |
| 運用 docs         | `docs/operations/runbook.md`、`docs/product/specs/billing.md`                              | 手動     | なし |
| 購読 event の設定 | Stripe Dashboard                                                                           | 人間判断 | なし |

### 10. env を追加

| 手順                 | 場所                                             | 分類     | 担保                                                                          |
| -------------------- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------- |
| schema に足す        | `src/env.ts`                                     | 入口     | —                                                                             |
| 1Password 管理の一覧 | `scripts/tasks/env/schema.ts`                    | 手動     | なし（env.ts との照合が無い）                                                 |
| op-env の雛形        | `.op-env.agent.example`、`.op-env.human.example` | 手動     | なし                                                                          |
| turbo の build env   | `turbo.json`                                     | 検査     | `scripts/__tests__/turbo-build-env-contract.test.ts`（build gate 必須分のみ） |
| 台帳                 | `docs/operations/secrets-ledger.md`              | 手動     | なし                                                                          |
| 実値の登録           | 1Password / Vercel                               | 人間判断 | `pnpm env:check`、`pnpm replica:check`                                        |

### 11. ページを追加

| 手順              | 場所                                   | 分類 | 担保                                   |
| ----------------- | -------------------------------------- | ---- | -------------------------------------- |
| page を作る       | `src/app/[locale]/**/page.tsx`         | 入口 | —                                      |
| proxy の保護区分  | `src/lib/auth/domain/access-policy.ts` | 手動 | なし（未分類ページの扱いは列挙に依存） |
| sitemap（公開時） | `src/app/sitemap.ts`（`publicPages`）  | 手動 | なし                                   |

### 12. feature を追加

| 手順               | 場所                                                       | 分類 | 担保                                                  |
| ------------------ | ---------------------------------------------------------- | ---- | ----------------------------------------------------- |
| ディレクトリを作る | `src/features/<name>/`                                     | 入口 | —                                                     |
| feature 名の認識   | `pnpm lint:boundaries`（feature DAG 検査）                 | 導出 | feature 名を path から自動抽出                        |
| 依存の許可・禁止   | `apps/product/eslint.config.mjs`（feature ごとのブロック） | 手動 | なし（削除済み `features/review` の参照が残っている） |
| barrel             | `src/features/<name>/index.ts`                             | 手動 | なし                                                  |

### 13. i18n namespace を追加

| 手順                     | 場所                                                    | 分類 | 担保                                                                             |
| ------------------------ | ------------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| product: en の JSON      | `apps/product/messages/en/<ns>.json`                    | 入口 | —                                                                                |
| product: ja の JSON      | `apps/product/messages/ja/<ns>.json`                    | 検査 | `pnpm lint:i18n`                                                                 |
| product: 読み込み        | `src/lib/i18n/request.ts`                               | 導出 | ディレクトリ走査                                                                 |
| product: 型              | `src/lib/i18n/messages.d.ts`                            | 手動 | なし                                                                             |
| product: client への配信 | `src/app/[locale]/(app)/layout.tsx`（`APP_NAMESPACES`） | 検査 | `check-i18n-integrity.ts`（使用されて未配信のみ。存在しない namespace は見ない） |
| web: 読み込み一覧        | `apps/web/src/platform/i18n/request.ts`（`NAMESPACES`） | 手動 | なし（漏れると無音で欠落）                                                       |
| web: 型                  | `apps/web/src/platform/i18n/messages.d.ts`              | 手動 | なし                                                                             |
| web: ja のキー一致       | `apps/web/messages/ja/`                                 | 手動 | なし（checker は product のみ）                                                  |

### 14. 価格・トライアル日数を変更

| 手順               | 場所                                                                                | 分類     | 担保 |
| ------------------ | ----------------------------------------------------------------------------------- | -------- | ---- |
| 値を変える         | `packages/billing/src/pricing.ts`                                                   | 入口     | —    |
| Stripe の Price    | Stripe Dashboard と Price ID の env                                                 | 人間判断 | なし |
| product の文言     | `apps/product/messages/{en,ja}/settings.json`（金額を直書き）                       | 手動     | なし |
| web の文言         | `apps/web/messages/{en,ja}/marketing.json`（金額・日数を直書き）                    | 手動     | なし |
| E2E の期待文字列   | `src/lib/test/e2e/billing.spec.ts`、`apps/web/src/test/e2e/i18n-smoke.spec.ts` ほか | 手動     | なし |
| webhook のログ文言 | `src/app/api/webhooks/stripe/route.ts`（`'7 days from now'`）                       | 手動     | なし |

### 15. Node のメジャー更新

| 手順             | 場所                                                       | 分類 | 担保                                         |
| ---------------- | ---------------------------------------------------------- | ---- | -------------------------------------------- |
| version を変える | `.nvmrc`                                                   | 入口 | —                                            |
| CI の共通 setup  | `.github/actions/setup/action.yml`                         | 導出 | `.nvmrc` を読む                              |
| engines          | `package.json`、`apps/web/package.json`                    | 手動 | なし                                         |
| 個別 workflow    | `.github/workflows/*.yml`（`node-version: 24` が 12 箇所） | 手動 | なし（`agent-preflight` はローカルのみ照合） |

## 更新の規則

- 新しい定型変更が繰り返されたら、レシピを追加する（[AI開発標準ループ](../operations/ai-development-loop.md) の「採用した知見を昇格する」の昇格先）。
- 機械化した PR は、該当行の分類・担保と集計を同じ変更で更新する。
- 「検査」へ上げる時は、漏れた時のエラー文が修正箇所を示すことを確認する。示さない検査は手動のまま数える。
