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

- Supabase の 3 つ（URL・publishable key・secret key）は必須で、欠けると起動時に throw する
- Resend・Stripe・Google Calendar・Upstash は任意。ただし **Vercel の Production では組で揃っていることを要求する**（一部だけ設定されている状態を拒否する）
- 組の検査に別のライフサイクルの secret を相乗りさせると、1 つ欠けただけでアプリ全体が起動しなくなる。足す前に `env.ts` の既存の組を確かめる

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

保存は通る（fail-open）。ただし本番の `/api/health` が Redis の失敗で 503 を返すので、UptimeRobot が DOWN を通知する。アプリ本体が動いていることを先に確かめる。

</details>

<details>
<summary>2. Resend が 1 時間止まった。失われるものは</summary>

確認メールは登録エラーとして見える。ウェルカムメールは「送った」と記録してから送るので、失敗すると再送されず欠落する。bounce の記録（webhook）は Resend 側の再送で追いつく。

</details>

<details>
<summary>3. Sentry が無音。障害は無いと言えるか</summary>

言えない。DSN が無いと黙って初期化しない。`/api/health` の transaction は inbound filter で捨てている。痕跡が無い時は Vercel の Function ログへ。

</details>
