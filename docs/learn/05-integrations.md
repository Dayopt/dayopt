---
status: current
last_verified: 2026-09-21
---

# 5. 外部サービス

## この章で答えられるようになる問い

- Vercel / Supabase / Resend / Stripe / Sentry / Upstash / Turnstile / Google は、それぞれ何が止まると何が止まるか
- 設定（env）が欠けた時、アプリは起動しないのか、黙って機能を止めるのか
- どのサービスを捨てる（乗り換える）のが重いか

## 概念

外部サービスとの付き合い方は、止まった時の振る舞いで 3 つに分けて覚える。

| 振る舞い    | 意味                                   | Dayopt の例                                                                            |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| fail-closed | 確かめられないなら止める               | メールの suppression 照会が失敗したら送らない                                          |
| fail-open   | 確かめられないなら通す（可用性を優先） | Upstash が落ちたら rate limit をメモリ上へ退避して通す。漏洩パスワード確認の失敗は通す |
| 相手が再送  | 失敗を返せば相手が送り直す             | Stripe / Resend の webhook は 500 を返すと再送される                                   |

## Dayopt ではどうなっているか

[外部サービスと停止マップ](system/services.md) が正本。`pnpm learn` の「サービス停止マップ」でサービスを押すと、止まる機能（赤）と弱まる機能（黄）が線で光る。

**env の扱い**は `apps/product/src/env.ts` にある。

- Supabase の 3 つ（URL・publishable key・secret key）は必須
- Vercel の Production では、Resend（API key・送信元・webhook secret）と Upstash も必須。Stripe（secret key と webhook secret）と Google Calendar（4 つ）は「全部あるか、全部無いか」で、一部だけの設定を拒否する
- 検査は起動の瞬間ではなく、最初に `env` を読んだ時に走る（テスト・build・CI では飛ばす）
- 本番の build は Sentry の DSN などが無いと失敗する（build gate）。逆に MCP の OAuth を有効にした Preview の build では、Resend・Stripe・Google・Sentry の env を置くこと自体を禁じている（`production-build-gate.mjs`）
- 組の検査に別のライフサイクルの secret を相乗りさせると、1 つ欠けただけでアプリ全体が動かなくなる。足す前に `env.ts` の既存の組を確かめる

**乗り換えの重さ**は infra.md の出口コスト台帳にある。Supabase が唯一の最深依存（Auth・DB・Storage・Edge Functions）。

## 関連する経路

- [サインアップ → ウェルカムメール](journeys/signup.md) — Resend が 2 経路で使われる
- [Google Calendar 連携](journeys/google-calendar.md) — OAuth と cron
- [Pro を契約する](journeys/billing.md) — Stripe の webhook と冪等性
- [問い合わせを送る](journeys/contact.md) — Idempotency-Key

## 正本

- [docs/engineering/infra.md](../engineering/infra.md) の「出口コスト台帳」「Bot 対策（Cloudflare Turnstile）」
- [docs/operations/secrets.md](../operations/secrets.md) — secret の置き場所（値は 1Password が正本）
- [docs/operations/monitoring.md](../operations/monitoring.md)

## 自分で確かめる問い

<details>
<summary>1. Upstash が落ちた。利用者は困るか。監視は何を言うか</summary>

画面からの保存は通る（fail-open）。一方で MCP・問い合わせ・アカウント削除の本人確認は止まる（fail-closed）。本番の `/api/health` は Redis の失敗で 503 を返すので、UptimeRobot が DOWN を通知する。どの経路が止まっているかを先に切り分ける。

</details>

<details>
<summary>2. Resend が 1 時間止まった。失われるものは</summary>

確認メールは登録エラーとして見える。ウェルカムメールは「送った」と記録してから送るので、失敗すると再送されず欠落する。bounce の記録（webhook）は Resend 側の再送で追いつく。

</details>

<details>
<summary>3. Sentry が無音。障害は無いと言えるか</summary>

言えない。Preview と local では DSN が無いと黙って初期化しない（本番の build は DSN が無いと失敗する）。`/api/health` の transaction は inbound filter で捨てている。痕跡が無い時は Vercel の Function ログへ。

</details>

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": "apps/product/src/env.ts",
    "find": "values.every(Boolean) || !values.some(Boolean)"
  },
  {
    "path": "apps/product/src/env.ts",
    "find": "はVercel Productionで必須です"
  },
  {
    "path": "apps/product/production-build-gate.mjs",
    "find": "FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV"
  },
  {
    "path": "packages/observability/build-gate.mjs",
    "find": "Sentry production build requires a valid"
  },
  {
    "path": "apps/product/src/lib/mcp/request-rate-limit.ts",
    "find": "return 'unavailable';"
  },
  {
    "path": "apps/product/src/features/contact/server/router.ts",
    "find": "Contact rate-limit service is unavailable"
  },
  {
    "path": "apps/product/src/lib/email/send.ts",
    "find": "suppression_lookup"
  }
]
```
