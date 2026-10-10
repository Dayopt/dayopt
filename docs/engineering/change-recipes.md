---
status: current
last_verified: 2026-10-10
---

# 定型変更レシピ台帳

定型の変更作業（「カテゴリ色を 1 つ足す」など）ごとに、**人間が決める判断**と、**判断から機械的に決まる展開**を分けて記録する台帳。[#3089](https://github.com/Dayopt/dayopt/issues/3089) の測定基盤で、目標は次の 2 つ。

1. 判断はすべて 1 箇所（決定入力）で宣言され、展開先で判断しない。
2. 展開はすべて導出・生成・検査のどれかで担保され、手動が 0。

原則（正本の置き場所と派生手段の選び方）は [正本と派生](./conventions.md#正本と派生判断と展開の分離) を正本とする。

この台帳は 2026-10-10 時点の現状記録。手順書として使う前に、該当レシピの記述を実コードと照合する。機械化を進めた PR は、同じ変更で該当行の分類と集計を更新する。

## 分類

### 判断（決定入力）

各レシピの「決定入力」表は、人間が決める項目を列挙する。

| 列     | 値                 | 意味                                                                                      |
| ------ | ------------------ | ----------------------------------------------------------------------------------------- |
| 決定者 | AUTONOMOUS         | 実装者が決めて Task / PR に書く                                                           |
|        | CHECKPOINT         | 顧客挙動・公開契約・権限 / プライバシー・課金。`type:question` で確認する                 |
|        | EXPLICIT AUTHORITY | 本番設定・実課金・不可逆 migration。[AGENTS.md](../../AGENTS.md) の権限境界に従う         |
| 状態   | 集約               | 1 箇所で宣言され、他はそこから展開される                                                  |
|        | 散在               | 同じ判断が複数箇所に書かれている、または判断の一部が展開先で行われている                  |
|        | 暗黙               | どこにも宣言されず、展開の中で黙って決まっている（例: `locale === 'ja' ? A : B` の else） |
|        | 規則化候補         | 既存データが規則に従っており、規則として記録すれば個別判断が不要になる                    |
|        | repo 外            | 正本が repo の外（Stripe Dashboard、Vercel、1Password）                                   |

### 展開

各レシピの「展開」表は、判断を受けて変わる場所を列挙する。

| 担保     | 意味                                                              |
| -------- | ----------------------------------------------------------------- |
| 導出     | 正本から型・値が派生するため、作業が無い                          |
| 生成     | 生成コマンドが書き、`--check` が差分を検出する                    |
| 検査     | 漏れると型エラー・test・CI が失敗し、エラー文から修正箇所が分かる |
| 手動     | 漏れても何も失敗しない。または失敗しても修正箇所が分からない      |
| 人間判断 | repo 外の操作。検査が CHECKPOINT として明示して止まる             |

片方向しか見ない検査や、固定リストに載った値しか見ない検査は、見ていない側を手動として数える。

## 集計

| #   | レシピ                     | 判断 | 散在 | 暗黙 | 規則化候補 | repo 外 | 展開 | 手動 | 人間判断 |
| --- | -------------------------- | ---- | ---- | ---- | ---------- | ------- | ---- | ---- | -------- |
| 1   | カテゴリ色を追加           | 6    | 2    | 1    | 1          | 0       | 12   | 7    | 0        |
| 2   | user_settings の選択肢追加 | 5    | 2    | 2    | 0          | 0       | 9    | 8    | 0        |
| 3   | locale を追加              | 9    | 3    | 5    | 0          | 0       | 17   | 14   | 0        |
| 4   | OAuth client を追加        | 7    | 2    | 1    | 0          | 0       | 13   | 10   | 0        |
| 5   | MCP tool を追加            | 7    | 3    | 1    | 0          | 0       | 13   | 6    | 0        |
| 6   | cron job を追加            | 9    | 4    | 1    | 2          | 0       | 13   | 8    | 0        |
| 7   | サービスエラーコードを追加 | 6    | 2    | 1    | 1          | 0       | 5    | 4    | 0        |
| 8   | DT エラーコードを追加      | 6    | 4    | 1    | 0          | 0       | 10   | 9    | 0        |
| 9   | Stripe webhook event 追加  | 6    | 2    | 1    | 0          | 1       | 6    | 5    | 1        |
| 10  | env を追加                 | 7    | 3    | 0    | 0          | 1       | 8    | 5    | 1        |
| 11  | ページを追加               | 5    | 1    | 1    | 1          | 0       | 8    | 5    | 0        |
| 12  | feature を追加             | 3    | 1    | 0    | 0          | 0       | 5    | 4    | 0        |
| 13  | i18n namespace を追加      | 5    | 1    | 0    | 0          | 0       | 10   | 6    | 0        |
| 14  | 価格・トライアル日数を変更 | 6    | 3    | 1    | 0          | 1       | 9    | 6    | 1        |
| 15  | Node のメジャー更新        | 3    | 1    | 0    | 0          | 1       | 7    | 4    | 1        |
|     | **合計**                   | 90   | 34   | 16   | 5          | 4       | 145  | 101  | 4        |

KPI は「散在 + 暗黙」（現在 50）と「展開の手動」（現在 101）。どちらも 0 を目標にする。規則化候補は、規則を [decisions.md](../decisions.md) に記録した時点で集約に移す。

初版（同日）は判断と展開を分けずに「手動 51」と数えていた。展開先の漏れと、展開に混入した判断を数え直した結果が上表。

## レシピ

パスは `apps/product/src/` 配下を `src/` と略す。

### 1. カテゴリ色を追加

決定入力:

| 項目           | 例                 | 決定者     | 現在の宣言場所                                                             | 状態       |
| -------------- | ------------------ | ---------- | -------------------------------------------------------------------------- | ---------- |
| 色名           | `'rose'`           | AUTONOMOUS | `src/features/activities/lib/category-colors.ts`（`CATEGORY_COLOR_NAMES`） | 散在       |
| パレット内の順 | `pink` の後        | AUTONOMOUS | 同配列の順序（UI がそのまま map）                                          | 集約       |
| 色相（hue）    | `10`               | AUTONOMOUS | `packages/foundations/src/tokens/colors.css`、`Colors.stories.tsx`         | 散在       |
| 明度・彩度     | 規則               | —          | `colors.css`                                                               | 規則化候補 |
| 色域外の彩度   | teal は C を下げた | AUTONOMOUS | `colors.css` の teal 行のコメントのみ                                      | 暗黙       |
| 表示名 en / ja | `Rose` / `ローズ`  | AUTONOMOUS | `messages/{en,ja}/common.json`（`common.colors.*`）                        | 集約       |

規則化候補の内容: 有彩色 9 色の 36 値は teal の彩度を除き「light: 本体 L=0.65 C=0.18、tint L=0.92 C=0.05 / dark: 本体 L=0.78 C=0.15、tint L=0.28 C=0.06、色相のみ変化」に一致する。例外は teal（色域が狭いため彩度を下げる）と gray（無彩色）。色相の「最小 25° 間隔」は `colors.css` のコメントにあるだけで検査されていない。

展開:

| 展開先                                                                               | 担保 | 使う決定   |
| ------------------------------------------------------------------------------------ | ---- | ---------- |
| `category-colors.ts`（`CATEGORY_COLOR_MAP`）                                         | 検査 | 色名       |
| `category-colors.ts` の Tailwind safelist コメント                                   | 手動 | 色名       |
| `src/features/activities/server/router.ts`（`CATEGORY_COLOR`）                       | 手動 | 色名       |
| `src/features/activities/server/activities-mutation-service.ts`（`CATEGORY_COLORS`） | 手動 | 色名       |
| 新 migration で `categories_color_valid` を再作成（CHECK 照合テスト）                | 検査 | 色名       |
| `colors.css` の 4 ブロック（light / dark × 本体 / tint）                             | 手動 | 色相、規則 |
| `packages/foundations/src/tailwind-theme.css` の 2 ブロック                          | 手動 | 色名       |
| `messages/{en,ja}/common.json`                                                       | 検査 | 表示名     |
| `packages/foundations/src/tokens/Colors.stories.tsx` の色相配列 3 箇所               | 手動 | 色名、色相 |
| `packages/foundations/src/tokens/Colors.mdx` のトークン表                            | 手動 | 色名       |
| 各 Story（`CATEGORY_COLOR_NAMES` を map）                                            | 導出 | 色名       |
| `LEGACY_HEX_MAP`                                                                     | 導出 | 不要       |

### 2. user_settings の選択肢を追加

決定入力:

| 項目                         | 例                          | 決定者     | 現在の宣言場所                                                                          | 状態 |
| ---------------------------- | --------------------------- | ---------- | --------------------------------------------------------------------------------------- | ---- |
| 設定と値                     | timeFormat に `'12h-short'` | CHECKPOINT | router・service・hook・UI・DB の 5 箇所以上                                             | 散在 |
| 表示文言 en / ja             | —                           | AUTONOMOUS | `messages/{en,ja}/settings.json`                                                        | 集約 |
| DB で強制するか              | —                           | AUTONOMOUS | timeFormat / weekStartsOn / theme は CHECK あり、defaultView / hourHeightDensity は無し | 暗黙 |
| 既定値・既存行の扱い         | —                           | CHECKPOINT | `src/lib/hooks/useUserPreferences.ts` ほか                                              | 散在 |
| 週の開始曜日を足す時の週境界 | —                           | CHECKPOINT | SQL 関数（`get_weekly_focus_score` など）、`src/lib/date/core.ts`                       | 暗黙 |

`src/lib/time/user-preference.ts` は値の定数を持つが、router・service からは参照されていない（型 `TimeFormat` だけが calendar から使われる）。正本の候補であって、現状の入口ではない。

展開:

| 展開先                                                                  | 担保 | 使う決定                                                                          |
| ----------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| `src/lib/time/user-preference.ts`                                       | 手動 | 値                                                                                |
| `src/features/settings/server/router.ts`（z.enum / z.literal）          | 手動 | 値                                                                                |
| `src/features/settings/server/settings-service.ts`（型と `as` cast）    | 手動 | 値                                                                                |
| `src/lib/hooks/useUserPreferences.ts`（独立した型の再定義）             | 手動 | 値                                                                                |
| `src/features/settings/hooks/useUserSettings.ts` のキーごとの変換       | 手動 | 値                                                                                |
| `src/features/settings/components/DisplaySettings.tsx`（選択肢と cast） | 手動 | 値、文言                                                                          |
| `messages/{en,ja}/settings.json`                                        | 検査 | 文言                                                                              |
| 新 migration で該当 CHECK を再作成（CHECK がある設定のみ）              | 手動 | 値（照合テストは `user-preference.ts` の定数と比べるが、router は導出していない） |
| 週の開始曜日: SQL 関数と `src/lib/date/core.ts`                         | 手動 | 値                                                                                |

### 3. locale を追加

決定入力:

| 項目                          | 例           | 決定者     | 現在の宣言場所                                                    | 状態 |
| ----------------------------- | ------------ | ---------- | ----------------------------------------------------------------- | ---- |
| locale コード                 | `ko`         | CHECKPOINT | `packages/config/src/i18n.ts`（`SUPPORTED_LOCALES`）              | 集約 |
| 言語の自称名                  | `한국어`     | AUTONOMOUS | `DisplaySettings.tsx` の三項演算子                                | 暗黙 |
| 日付・数値の書式              | `ko-KR`      | AUTONOMOUS | date-fns locale と Intl タグの `=== 'ja' ?` 直書き（10 箇所以上） | 散在 |
| 日付表記の既定                | `yyyy/MM/dd` | CHECKPOINT | `src/lib/hooks/useUserPreferences.ts` の二択                      | 暗黙 |
| メール（認証・通知・課金）    | 対応する     | CHECKPOINT | Edge Function、`src/emails/`、通知、Stripe webhook                | 散在 |
| 分析上の言語分類              | —            | AUTONOMOUS | `packages/observability/src/posthog-capture.ts`                   | 暗黙 |
| 公開 docs・blog・legal の範囲 | 全部         | CHECKPOINT | どこにも無い                                                      | 暗黙 |
| 翻訳の担当と品質基準          | —            | CHECKPOINT | どこにも無い（`add-locale` は `[TRANSLATE]` で埋める）            | 暗黙 |
| Turnstile の言語              | `ko`         | AUTONOMOUS | `Turnstile.tsx`（product / web）、`LoginForm.tsx` ほか            | 散在 |

暗黙の判断の多くは `locale === 'ja' ? A : B` の else に黙って落ちる形。locale ごとの値を `Record<Locale, …>` のプロファイル 1 つにまとめると、新 locale で型エラーになり集約できる。

展開:

| 展開先                                                                                                                               | 担保 | 使う決定                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------- |
| routing・request・settings router・sitemap・web mdx など `SUPPORTED_LOCALES` 参照箇所                                                | 導出 | locale コード                                                             |
| `apps/product/messages/<locale>/`                                                                                                    | 生成 | locale コード（`add-locale`。`--check` は無く、案内文のパスが現存しない） |
| `apps/web/messages/<locale>/`                                                                                                        | 手動 | locale コード                                                             |
| 検査 script の locale 直書き（`scripts/tasks/check-i18n-integrity.ts`、`check-glossary.ts`、`docs-coverage/collect.ts`、用語集の型） | 手動 | locale コード                                                             |
| web の docs / blog ページ、content 検証 script、`page-metadata.ts`                                                                   | 手動 | locale コード                                                             |
| `packages/observability/src/posthog-capture.ts`                                                                                      | 手動 | 分析上の分類                                                              |
| Storybook の next-intl mock                                                                                                          | 手動 | locale コード                                                             |
| 認証メール Edge Function（`supabase/functions/send-auth-email/` の 7 ファイル）                                                      | 手動 | メール                                                                    |
| `src/emails/*.tsx` の `Locale` 型（`src/emails/i18n.ts` の `Record` だけ検査）                                                       | 手動 | メール                                                                    |
| 通知・課金メールの Intl タグ（`src/lib/email/notifications.ts`、Stripe webhook）                                                     | 手動 | 書式                                                                      |
| date-fns locale の直書き（`MobileCalendarHeader`、`DateRangeDisplay`、`DateDisplay`）                                                | 手動 | 書式                                                                      |
| 日付表記・期間表示の二択（`useUserPreferences.ts`、`format-activity-duration.ts`）                                                   | 手動 | 日付表記の既定                                                            |
| `DisplaySettings.tsx` の言語名                                                                                                       | 手動 | 自称名                                                                    |
| Turnstile の言語指定（4 箇所）                                                                                                       | 手動 | Turnstile                                                                 |
| `settings-service.ts` の `'en' \| 'ja'` cast                                                                                         | 手動 | locale コード                                                             |
| 新 migration で `preferred_locale` の CHECK を再作成（CHECK 照合テスト）                                                             | 検査 | locale コード                                                             |
| `apps/web/content/{docs,blog,legal}/<locale>/`                                                                                       | 手動 | 公開範囲                                                                  |

### 4. OAuth client を追加

決定入力:

| 項目                               | 例                           | 決定者     | 現在の宣言場所                                                                              | 状態 |
| ---------------------------------- | ---------------------------- | ---------- | ------------------------------------------------------------------------------------------- | ---- |
| client id                          | `'gemini'`                   | CHECKPOINT | `src/lib/oauth-server/redirect-uris.ts`（`OAuthClientId`）、`mcp-gate`、DB                  | 散在 |
| 表示名                             | `'Gemini'`                   | AUTONOMOUS | `src/lib/oauth-server/clients.ts`、`messages/*/settings.json`、`McpConnectionsSettings.tsx` | 散在 |
| 既定 redirect URI                  | —                            | CHECKPOINT | `redirect-uris.ts`（`DEFAULT_REDIRECT_URIS`）                                               | 集約 |
| redirect URI の検証規則            | host + path                  | CHECKPOINT | `redirect-uris.ts` の client ごとの switch                                                  | 集約 |
| 追加 URI の env 名                 | `OAUTH_GEMINI_REDIRECT_URIS` | AUTONOMOUS | `clients.ts`（`EXTRA_REDIRECT_URI_ENV`）                                                    | 集約 |
| DB CHECK に `'unknown'` を含めるか | —                            | AUTONOMOUS | 3 制約は含み、2 制約は含まない                                                              | 暗黙 |
| write の有効化                     | 初期は無効                   | CHECKPOINT | env `MCP_WRITE_ENABLED_CLIENTS`                                                             | 集約 |

展開:

| 展開先                                                                                                        | 担保 | 使う決定                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| `clients.ts`（`EXTRA_REDIRECT_URI_ENV`、`CLIENTS`）                                                           | 検査 | id、表示名                                                             |
| `src/env.ts`（redirect URI の env）                                                                           | 検査 | env 名                                                                 |
| `redirect-uris.ts` の検証 switch の case                                                                      | 手動 | 検証規則（型での網羅は未確認）                                         |
| `scripts/tasks/env/schema.ts`（staging と production-pending の 2 箇所）                                      | 手動 | env 名                                                                 |
| `.op-env.agent.example`                                                                                       | 手動 | env 名（test は MCP 変数の固定リストのみ）                             |
| `scripts/runbook/setup-1password.sh`（2 箇所）                                                                | 手動 | env 名                                                                 |
| `docs/operations/secrets-ledger.md`                                                                           | 手動 | env 名                                                                 |
| `scripts/tasks/mcp-gate.ts`（`VALID_CLIENT_IDS`）                                                             | 手動 | id                                                                     |
| DB: client_id の CHECK 5 制約と関数内の配列 3 箇所（新 migration）                                            | 手動 | id、unknown（照合テストの値は `OAuthClientId` の写しで、正本は #3095） |
| `McpConnectionsSettings.tsx`（`clientLabelFor`）と `messages/*/settings.json`（未知は「Unknown client」表示） | 手動 | 表示名                                                                 |
| test（`redirect-uris.test.ts`、`clients.test.ts` の env stub、`supabase/tests/`）                             | 手動 | id                                                                     |
| 公開 docs と `docs/product/specs/auth.md`                                                                     | 手動 | id、表示名                                                             |
| `docs/engineering/data/system-surface.md`                                                                     | 生成 | env 名                                                                 |

### 5. MCP tool を追加

決定入力:

| 項目                        | 例                    | 決定者     | 現在の宣言場所                                                                        | 状態 |
| --------------------------- | --------------------- | ---------- | ------------------------------------------------------------------------------------- | ---- |
| tool 名                     | `'categories.create'` | CHECKPOINT | `src/app/api/mcp/_tools/registry.ts`、`registerTool` 呼び出し、test の期待配列        | 散在 |
| read / write                | read                  | CHECKPOINT | 実装経路（read は tRPC、write は RPC）                                                | 集約 |
| 必要 scope                  | `read:activities`     | CHECKPOINT | `registry.ts` の `requiredScope`、tool 内の scope 判定、`src/lib/trpc/procedures.ts`  | 散在 |
| 入出力 schema               | zod                   | CHECKPOINT | `_tools/*-contract.ts`                                                                | 集約 |
| description                 | —                     | CHECKPOINT | `registerTool` の引数                                                                 | 集約 |
| 新 scope の名前と文言       | `read:foo`            | CHECKPOINT | `src/lib/oauth-server/scopes.ts`、`messages/*/oauth.json`、`messages/*/settings.json` | 散在 |
| 上限・エラー分類・retryable | —                     | CHECKPOINT | 各 tool の実装                                                                        | 暗黙 |

展開:

| 展開先                                                                   | 担保 | 使う決定                                         |
| ------------------------------------------------------------------------ | ---- | ------------------------------------------------ |
| `register<X>Tool` の実装（descriptor と実登録の一致）                    | 検査 | tool 名                                          |
| `_tools/list-tools.test.ts` の期待 tool 名配列                           | 検査 | tool 名                                          |
| `_server.ts` など descriptor 参照箇所                                    | 導出 | tool 名                                          |
| `_tools/contract-snapshot.test.ts` の `CONTRACTS` と snapshot            | 手動 | schema（`CONTRACTS` に足すまで対象外）           |
| `src/lib/trpc/procedures.ts`（`MCP_TRPC_SCOPE_REQUIREMENTS`、read のみ） | 手動 | scope（漏れると実行時 403）                      |
| 新 scope: `scopes.ts` の `WRITE_SCOPES`                                  | 検査 | 新 scope                                         |
| 新 scope: `private.oauth_supported_scopes_v1()`                          | 検査 | 新 scope（integration test。ローカル DB が要る） |
| 新 scope: `messages/*/oauth.json`                                        | 検査 | 新 scope                                         |
| 新 scope: `messages/*/settings.json` と `scopeLabelFor`                  | 手動 | 新 scope                                         |
| 構成図・system surface                                                   | 生成 | tool 名                                          |
| 公開 docs `apps/web/content/docs/{en,ja}/data/api-mcp.mdx`               | 手動 | 新 scope                                         |
| write tool: `apply_mcp_*` RPC、`McpMutationClient`、envelope の tool 名  | 手動 | tool 名、write                                   |
| `docs/product/specs/*` の tool 言及                                      | 手動 | tool 名                                          |

### 6. cron job を追加

決定入力:

| 項目              | 例                       | 決定者     | 現在の宣言場所                                                                        | 状態       |
| ----------------- | ------------------------ | ---------- | ------------------------------------------------------------------------------------- | ---------- |
| job 名            | `billing-reconciliation` | AUTONOMOUS | policy、型 2 つ、`vercel.json`、route、DB CHECK、運用 test の 7 箇所                  | 散在       |
| 実行基盤          | Vercel / pg_cron         | AUTONOMOUS | 9 job 中 Vercel 4、pg_cron 5                                                          | 規則化候補 |
| schedule          | `15 2 * * *`             | AUTONOMOUS | `apps/product/vercel.json` または migration の `cron.schedule`                        | 集約       |
| 監視上限（分）    | `1560`                   | AUTONOMOUS | `src/lib/ops/cron-heartbeat-policy.mjs`（`JOB_MAX_AGE_MINUTES`）                      | 規則化候補 |
| 期待状態          | `enabled` / `inactive`   | CHECKPOINT | 同 policy（`EXPECTED_JOB_MODES`）と `.d.mts`                                          | 散在       |
| maxDuration（秒） | `60`                     | AUTONOMOUS | route の `export const maxDuration` と `src/app/route-duration-contract.test.ts` の表 | 散在       |
| 内部の時間予算    | `50_000` ms              | AUTONOMOUS | route 内                                                                              | 集約       |
| 認証・write fence | `CRON_SECRET` 照合       | CHECKPOINT | 既存 route からの複製                                                                 | 散在       |
| 完了の定義        | heartbeat を書く位置     | AUTONOMOUS | route 内                                                                              | 暗黙       |

規則化候補の内容: 実行基盤は「外部 I/O があれば Vercel route、DB 内で閉じれば pg_cron」が実態。監視上限は確認できた 4 job で「周期 × 3（日次は 26 時間）」に一致する（残り 5 job は未検証）。

展開:

| 展開先                                                                      | 担保 | 使う決定                                            |
| --------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| health route・本番監査・route test（policy を import）                      | 導出 | job 名                                              |
| `src/lib/ops/cron-heartbeat-policy.d.mts`                                   | 手動 | job 名、期待状態                                    |
| `src/lib/ops/cron-heartbeat.ts`（`CronJob`）                                | 手動 | job 名                                              |
| `src/app/api/cron/<job>/route.ts` と `route-duration-contract.test.ts` の表 | 検査 | maxDuration                                         |
| route 内の `CRON_SECRET` 照合                                               | 手動 | 認証                                                |
| `apps/product/vercel.json`（`crons`）                                       | 手動 | schedule（本番監査で missing になって初めて気づく） |
| pg_cron の場合の `cron.schedule` と heartbeat 書込 SQL                      | 手動 | job 名、schedule                                    |
| 新 migration で `cron_heartbeats_job_name_check` を再作成                   | 検査 | job 名（CHECK 照合テストで双方向）                  |
| `supabase/tests/cron-heartbeats.sql` の件数                                 | 手動 | job 名（件数がハードコード）                        |
| system surface・`docs/learn/system/entrypoints.md`                          | 生成 | job 名、schedule                                    |
| `docs/operations/monitoring.md`                                             | 手動 | 全般                                                |
| `docs/engineering/invariants.md` の cron 記述                               | 手動 | 全般                                                |
| 運用 test の `EXPECTED_JOB_MODES` 完全一致                                  | 検査 | 期待状態                                            |

### 7. サービスエラーコードを追加

決定入力:

| 項目                | 例                         | 決定者     | 現在の宣言場所                                                     | 状態             |
| ------------------- | -------------------------- | ---------- | ------------------------------------------------------------------ | ---------------- |
| code                | `BILLING_RESPONSE_EXPIRED` | AUTONOMOUS | throw 箇所（`ServiceError.code` は `string`）                      | 集約             |
| tRPC code           | `CONFLICT`                 | CHECKPOINT | `src/lib/trpc/error-code-map.ts`                                   | 散在・規則化候補 |
| Sentry に報告するか | —                          | AUTONOMOUS | tRPC code の副作用（`INTERNAL_SERVER_ERROR` / `TIMEOUT` なら報告） | 暗黙             |
| client に見せるか   | —                          | CHECKPOINT | `src/lib/trpc/client-safe-service-code.ts`                         | 散在             |
| UI の分岐           | —                          | CHECKPOINT | 呼び出し側 component                                               | 集約             |
| 文言 en / ja        | —                          | CHECKPOINT | `messages/*`                                                       | 集約             |

規則化候補の内容: `error-code-map.ts` の集計で、`*_NOT_FOUND` → `NOT_FOUND` は 4/4、`*_FAILED` → `INTERNAL_SERVER_ERROR` は 27/29（例外 2 件は Sentry 報告を避けるために `BAD_REQUEST` を選んだもの）、`BILLING_*` → `CONFLICT` は 6/6。Sentry 報告を独立の項目にすれば、残りは規則で決まる。

展開:

| 展開先                                                     | 担保 | 使う決定                                 |
| ---------------------------------------------------------- | ---- | ---------------------------------------- |
| `error-code-map.ts`                                        | 手動 | tRPC code（漏れると 500 と Sentry 報告） |
| `client-safe-service-code.ts`                              | 手動 | client に見せるか                        |
| `src/lib/trpc/router.ts` の `serviceCode` 転送             | 導出 | client に見せるか                        |
| UI の分岐と文言                                            | 手動 | UI、文言                                 |
| timeblock 系: `timeblock-command-client.ts` のメッセージ表 | 手動 | 文言                                     |

### 8. DT エラーコードを追加

決定入力:

| 項目                                   | 例              | 決定者     | 現在の宣言場所                                                                          | 状態 |
| -------------------------------------- | --------------- | ---------- | --------------------------------------------------------------------------------------- | ---- |
| DT 番号                                | `DT015`         | AUTONOMOUS | migration の `ERRCODE`（採番台帳なし。DT010 欠番、旧規則の 5 番号は両表に無い）         | 暗黙 |
| 規則の意味                             | —               | CHECKPOINT | SQL 本文と `docs/engineering/invariants.md`                                             | 散在 |
| UI 経路の code とメッセージ            | `STALE_VERSION` | CHECKPOINT | `src/features/timeblock/server/timeblock-command-client.ts` の 2 表と DT001 の特別処理  | 散在 |
| MCP 経路の code・メッセージ・retryable | `CONFLICT`      | CHECKPOINT | `mcp-mutation-client.ts`、`_tools/timeblock-mutations.ts`（`isRetryableMutationError`） | 散在 |
| tRPC code・client に見せるか           | —               | CHECKPOINT | レシピ 7 と同じ                                                                         | 散在 |
| UI の toast 文言                       | —               | CHECKPOINT | `useTimeblockWriteMutations.ts`                                                         | 集約 |

UI と MCP の 2 表は DT001 と DT002 で値が違う（DT002 は UI が `STALE_VERSION`、MCP が `CONFLICT`）。意図した差か drift かはコードから読めない。

展開:

| 展開先                                                                              | 担保 | 使う決定                                                  |
| ----------------------------------------------------------------------------------- | ---- | --------------------------------------------------------- |
| `timeblock-command-client.ts` の code 表とメッセージ表                              | 手動 | UI 経路                                                   |
| `mcp-mutation-client.ts`（`EXPECTED_ERROR_CODES`）                                  | 手動 | MCP 経路                                                  |
| 新 MCP code の場合: `McpMutationErrorCode` と `ERROR_MESSAGES`                      | 検査 | MCP 経路                                                  |
| `isRetryableMutationError`                                                          | 手動 | MCP 経路                                                  |
| 新 service code の場合: `error-code-map.ts`、`client-safe-service-code.ts`          | 手動 | tRPC code                                                 |
| UI の文言                                                                           | 手動 | toast                                                     |
| `invariants.md` の写し表                                                            | 手動 | 意味（`architecture:check` は表と code の同期だけを見る） |
| 時刻規則の場合: `_tools/timeblock-context-contract.ts`（`TIMEBLOCK_CONTEXT_RULES`） | 手動 | 意味                                                      |
| 公開 docs `api-mcp.mdx`                                                             | 手動 | MCP 経路                                                  |
| `supabase/tests/` と integration test                                               | 手動 | 意味                                                      |

### 9. Stripe webhook event を追加

決定入力:

| 項目                     | 例             | 決定者             | 現在の宣言場所                                                | 状態    |
| ------------------------ | -------------- | ------------------ | ------------------------------------------------------------- | ------- |
| event type               | `invoice.paid` | CHECKPOINT         | `src/app/api/webhooks/stripe/route.ts` の switch              | 散在    |
| 業務効果                 | —              | CHECKPOINT         | 同 case 本体                                                  | 集約    |
| 再照合の対象か           | —              | CHECKPOINT         | `billing-webhook-reconciliation.ts`（`RELEVANT_EVENT_TYPES`） | 散在    |
| Dashboard の購読         | —              | EXPLICIT AUTHORITY | Stripe Dashboard                                              | repo 外 |
| deploy と購読の順序      | deploy が先    | CHECKPOINT         | durable mode の未対応 event が 500 を返す実装に依存           | 暗黙    |
| maxDuration の再見積もり | —              | AUTONOMOUS         | `route-duration-contract.test.ts` のコメント                  | 集約    |

展開:

| 展開先                           | 担保     | 使う決定                     |
| -------------------------------- | -------- | ---------------------------- |
| `RELEVANT_EVENT_TYPES`           | 手動     | 再照合                       |
| `docs/product/specs/billing.md`  | 手動     | 業務効果                     |
| `docs/operations/runbook.md`     | 手動     | 購読                         |
| `docs/learn/journeys/billing.md` | 手動     | 業務効果（生成物かは未確認） |
| route の test                    | 手動     | 業務効果                     |
| Stripe Dashboard の購読設定      | 人間判断 | 購読、順序                   |

### 10. env を追加

決定入力:

| 項目                     | 例                 | 決定者             | 現在の宣言場所                                                                              | 状態    |
| ------------------------ | ------------------ | ------------------ | ------------------------------------------------------------------------------------------- | ------- |
| 名前                     | `UPPER_SNAKE`      | AUTONOMOUS         | `src/env.ts`、schema、example、setup script、台帳                                           | 散在    |
| 型と optional / required | `z.string().url()` | AUTONOMOUS         | `src/env.ts`（production 必須は CHECKPOINT）                                                | 集約    |
| secret / public          | secret             | CHECKPOINT         | `scripts/tasks/env/schema.ts`、`scripts/tasks/check-client-bundle-secrets.mjs` の固定リスト | 散在    |
| 置く環境と vault         | agent / human / ci | CHECKPOINT         | `schema.ts` のどの配列に書くか                                                              | 散在    |
| build 時に必須か         | —                  | CHECKPOINT         | `apps/product/production-build-gate.mjs`                                                    | 集約    |
| CI secret として使うか   | —                  | CHECKPOINT         | `schema.ts`（`ciSecretSchema`）                                                             | 集約    |
| Vercel への複製          | —                  | EXPLICIT AUTHORITY | Vercel                                                                                      | repo 外 |

展開:

| 展開先                                                         | 担保     | 使う決定                                              |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `scripts/tasks/env/schema.ts`                                  | 手動     | 名前、環境、vault（`env.ts` との照合なし）            |
| `.op-env.agent.example`、`.op-env.human.example`               | 手動     | vault（test は MCP 変数のみ）                         |
| `scripts/runbook/setup-1password.sh`                           | 手動     | vault                                                 |
| `turbo.json`（`tasks.build.env`）                              | 検査     | build 必須（build gate 必須分のみ）                   |
| `apps/product/production-build-gate.mjs`                       | 検査     | build 必須（単一変数の production 必須 refine のみ）  |
| `scripts/tasks/check-client-bundle-secrets.mjs`（secret のみ） | 手動     | secret                                                |
| `docs/operations/secrets-ledger.md`                            | 手動     | 全般                                                  |
| 1Password / Vercel への実値登録                                | 人間判断 | 全般（`pnpm env:check`、`pnpm replica:check` が照合） |

### 11. ページを追加

決定入力:

| 項目                          | 例         | 決定者     | 現在の宣言場所                                                        | 状態             |
| ----------------------------- | ---------- | ---------- | --------------------------------------------------------------------- | ---------------- |
| path                          | `/reports` | AUTONOMOUS | `src/app/[locale]/<group>/**/page.tsx`                                | 集約             |
| layout group                  | `(app)`    | AUTONOMOUS | ディレクトリ配置（配信 namespace と noindex が決まる）                | 集約             |
| 保護区分                      | protected  | CHECKPOINT | `src/lib/auth/domain/access-policy.ts` の配列と `proxy.ts` の個別分岐 | 散在・規則化候補 |
| 認証済みで auth path を許すか | —          | CHECKPOINT | `access-policy.ts`（`authPathsAllowedWhileAuthenticated`）            | 集約             |
| sitemap に載せるか            | —          | AUTONOMOUS | product と web の 2 つの `sitemap.ts`                                 | 暗黙             |

規則化候補の内容: 「`(app)` = protected、`(auth)` = auth、`oauth/*` = protected」は現在のページツリーと完全に一致する。`/` だけが `pathname === '/'` の特例で保護されている。

**未分類ページは fail-open**: どの配列にも無い path では、`proxy.ts` の未ログイン redirect と MFA（AAL2）の確認がどちらも発火しない。`(app)/layout.tsx` は独自の認証確認を持たず、データは tRPC の `protectedProcedure` が守るが、UI shell は描画される。現時点で未分類のページは無い。

展開:

| 展開先                                  | 担保 | 使う決定                          |
| --------------------------------------- | ---- | --------------------------------- |
| `access-policy.ts` の配列               | 手動 | 保護区分（漏れると fail-open）    |
| `access-policy.ts` の認証済み許可リスト | 手動 | auth path                         |
| `src/app/sitemap.ts`                    | 手動 | sitemap                           |
| `apps/web/src/app/sitemap.ts`           | 手動 | sitemap                           |
| layout の配信 namespace                 | 検査 | group（`(app)` と `(auth)` のみ） |
| noindex                                 | 導出 | group                             |
| `proxy.ts` の matcher                   | 導出 | path                              |
| ナビゲーション・サイドバーのリンク      | 手動 | path                              |

### 12. feature を追加

決定入力:

| 項目                     | 例         | 決定者     | 現在の宣言場所                                                                     | 状態 |
| ------------------------ | ---------- | ---------- | ---------------------------------------------------------------------------------- | ---- |
| 名前                     | `reports`  | AUTONOMOUS | `src/features/<name>/`                                                             | 集約 |
| 層と依存してよい feature | Layer 1    | CHECKPOINT | `apps/product/eslint.config.mjs` の各 feature ブロック（禁止リストが否定形で分散） | 散在 |
| 公開面                   | `index.ts` | AUTONOMOUS | `src/features/<name>/index.ts`                                                     | 集約 |

展開:

| 展開先                                                       | 担保 | 使う決定                                                          |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------------------- |
| `eslint.config.mjs` に新 feature のブロックを追加            | 手動 | 層（他 feature を import した時だけ `architecture:check` が検出） |
| `eslint.config.mjs` の既存ブロックに新 feature の禁止を追記  | 手動 | 層（漏れると既存 feature から import できる）                     |
| `src/features/<name>/index.ts`                               | 手動 | 公開面                                                            |
| `docs/engineering/architecture.md` の DAG、構成図、inventory | 生成 | 名前、層                                                          |
| 用語集の `code.feature`（該当時）                            | 手動 | 名前                                                              |

`eslint.config.mjs` と `architecture.md` には、削除済みの `features/review` の参照が残っている。

### 13. i18n namespace を追加

決定入力:

| 項目                                  | 例              | 決定者     | 現在の宣言場所                                                    | 状態 |
| ------------------------------------- | --------------- | ---------- | ----------------------------------------------------------------- | ---- |
| 名前                                  | `reports`       | AUTONOMOUS | `messages/en/<ns>.json` のファイル名                              | 集約 |
| app                                   | product         | AUTONOMOUS | 置き場所                                                          | 集約 |
| 配信（server のみ / client と group） | client, `(app)` | AUTONOMOUS | 3 つの layout（`(app)`、`(auth)`、`oauth`）の配列                 | 散在 |
| 翻訳文                                | —               | CHECKPOINT | `messages/{en,ja}/<ns>.json`（用語は glossary に従う）            | 集約 |
| 複数トップキーの例外                  | —               | AUTONOMOUS | `scripts/tasks/check-i18n-integrity.ts`（`MULTI_KEY_EXCEPTIONS`） | 集約 |

展開:

| 展開先                                                       | 担保 | 使う決定                           |
| ------------------------------------------------------------ | ---- | ---------------------------------- |
| product: `messages/ja/<ns>.json`                             | 検査 | 翻訳文（`pnpm lint:i18n`）         |
| product: `src/lib/i18n/request.ts`                           | 導出 | 名前                               |
| product: `src/lib/i18n/messages.d.ts`                        | 手動 | 名前                               |
| product: `(app)` / `(auth)` layout の配信                    | 検査 | 配信                               |
| product: `oauth/layout.tsx` の配信                           | 手動 | 配信（検査対象外）                 |
| product: 禁止表記                                            | 検査 | 翻訳文（`pnpm copy:check:strict`） |
| web: `apps/web/src/platform/i18n/request.ts`（`NAMESPACES`） | 手動 | 名前（漏れても console warn のみ） |
| web: `apps/web/src/platform/i18n/messages.d.ts`              | 手動 | 名前                               |
| web: ja のキー一致                                           | 手動 | 翻訳文（checker は product のみ）  |
| web: 禁止表記                                                | 手動 | 翻訳文（検査対象外）               |

### 14. 価格・トライアル日数を変更

決定入力:

| 項目                            | 例         | 決定者             | 現在の宣言場所                                                                        | 状態    |
| ------------------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------- | ------- |
| 月額                            | 500 セント | CHECKPOINT         | `packages/billing/src/pricing.ts`（`monthlyUsdCents` と `displayPrice` の二重）、文言 | 散在    |
| 通貨                            | USD        | CHECKPOINT         | 名前に埋め込み（`monthlyUsdCents`）                                                   | 暗黙    |
| アプリ体験日数                  | 45         | CHECKPOINT         | `packages/billing/src/access.ts`（`appTrialDays`）、DB CHECK（1080 時間）、文言       | 散在    |
| Stripe trial 日数（旧契約のみ） | 7          | CHECKPOINT         | `pricing.ts`（`dayoptProTrialDays`）、文言                                            | 散在    |
| Stripe Price ID                 | `price_…`  | EXPLICIT AUTHORITY | Stripe と env（コードは `price_` prefix のみ検証）                                    | repo 外 |
| web と product の表示切替の順序 | —          | CHECKPOINT         | `docs/operations/billing-single-plan-rollout.md`                                      | 集約    |

web が 7 日、product が 45 日を表示しているのは、公開順の判断による意図的な差。機械的に揃えてはいけない。

展開:

| 展開先                                                                                             | 担保     | 使う決定                               |
| -------------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| `pricing.ts` の `displayPrice`                                                                     | 手動     | 月額（セントから導出できる）           |
| `PricingSection`、`LandingPage`、`BillingSettings`                                                 | 導出     | 月額                                   |
| 文言の直書き（product の `settings.json` / `common.json`、web の `marketing.json` / `legal.json`） | 手動     | 月額、日数                             |
| DB の 1080 時間 CHECK と `supabase/tests/`（不可逆 migration）                                     | 手動     | 体験日数                               |
| E2E の期待文字列                                                                                   | 検査     | 月額、日数（失敗文は決定値を示さない） |
| Stripe webhook のログ文言                                                                          | 手動     | Stripe trial                           |
| 公開 docs（`faq/pricing.mdx`）、`docs/product/specs/billing.md`、`docs/business/pricing.md`        | 手動     | 月額、日数                             |
| `src/emails/TrialStartEmail.tsx`、`packages/billing/README.md`                                     | 手動     | 日数                                   |
| Stripe の Price と env                                                                             | 人間判断 | Price ID                               |

### 15. Node のメジャー更新

決定入力:

| 項目                | 例    | 決定者     | 現在の宣言場所        | 状態    |
| ------------------- | ----- | ---------- | --------------------- | ------- |
| Node major          | 24    | AUTONOMOUS | `.nvmrc`              | 集約    |
| `@types/node` major | `^24` | AUTONOMOUS | 4 つの `package.json` | 散在    |
| Vercel の Node 設定 | —     | —          | Vercel Project 設定   | repo 外 |

展開:

| 展開先                                                     | 担保     | 使う決定                                                 |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------- |
| `.github/actions/setup/action.yml`                         | 導出     | Node major                                               |
| `agent-preflight`、CI の impact 判定                       | 導出     | Node major                                               |
| `package.json`、`apps/web/package.json` の `engines`       | 手動     | Node major                                               |
| `.github/workflows/*.yml` の `node-version: 24`（12 箇所） | 手動     | Node major（`node-version-file: .nvmrc` で導出にできる） |
| `@types/node`（4 箇所）                                    | 手動     | `@types/node`                                            |
| docs と skill の Node 24 言及                              | 手動     | Node major                                               |
| Vercel Project の Node 設定                                | 人間判断 | Node major                                               |

## 更新の規則

- 新しい定型変更が繰り返されたら、レシピを追加する（[AI開発標準ループ](../operations/ai-development-loop.md) の「採用した知見を昇格する」の昇格先）。
- 機械化した PR は、該当行の分類と集計を同じ変更で更新する。
- 判断を集約したら、決定入力の「現在の宣言場所」を 1 箇所にし、状態を「集約」にする。
- 「検査」へ上げる時は、漏れた時のエラー文が修正箇所を示すことを確認する。示さない検査は手動のまま数える。
- 規則化候補は、規則を [decisions.md](../decisions.md) に記録してから集約に移す。
