---
status: current
last_verified: 2026-08-13
---

# 契約サービス一覧

Dayopt が運用時に依存する外部サービスの索引。ここでは用途と確認先を管理し、料金・上限・契約プランの値は各サービスの管理画面または請求書を正とする。コード上の依存は `package.json`、環境変数は `scripts/tasks/env/schema.ts` と Vercel / 1Password の設定を確認する。

| サービス                 | 用途                                                                                                       | リポジトリ内の確認先                                                                                | 契約情報の正本                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Vercel                   | Web 配信、Functions、Analytics                                                                             | `vercel.json`、`.github/workflows/`                                                                 | Vercel dashboard / invoice                |
| Supabase                 | PostgreSQL、Auth、Storage、Realtime                                                                        | `supabase/`、`packages/supabase/`                                                                   | Supabase organization dashboard / invoice |
| Sentry                   | エラー・パフォーマンス監視                                                                                 | Product / Web の別project、`packages/observability`、[monitoring](../operations/monitoring.md)      | Sentry organization settings / invoice    |
| Upstash Redis            | rate limit の共有 backend                                                                                  | `apps/product/src/lib/rate-limit/`、`apps/web/src/platform/security/rate-limit.ts`                  | provider dashboard / invoice              |
| Stripe                   | subscription、Checkout、Portal、Webhook                                                                    | `apps/product/src/features/billing/`、[billing spec](../product/specs/billing.md)                   | Stripe dashboard                          |
| Resend                   | transactional email、問い合わせ送信・返信SMTP                                                              | `packages/email/`、両appのcontact / Resend webhook、[contact email](../operations/contact-email.md) | Resend dashboard / invoice                |
| GitHub                   | repository、Issues / PR、Actions                                                                           | `.github/`                                                                                          | repository / organization settings        |
| Cloudflare Turnstile     | 公開フォームのbot対策                                                                                      | `apps/web/src/lib/turnstile/`、`apps/web/src/app/api/contact/`                                      | Cloudflare dashboard                      |
| Cloudflare Email Routing | `support@dayopt.app`の受信・転送                                                                           | [contact email](../operations/contact-email.md)                                                     | Cloudflare dashboard                      |
| Cloudflare DNS           | `dayopt.app`の権威DNSゾーン管理（レコード変更はここで行う）                                                | [infra.md §DNS管理](../engineering/infra.md#dns-管理cloudflare)                                     | Cloudflare dashboard                      |
| Google Gmail             | 問い合わせの運用受信箱・返信                                                                               | [contact email](../operations/contact-email.md)                                                     | Google account settings                   |
| 1Password                | secret の master 管理とローカル注入                                                                        | `.op-env.agent.example`、`scripts/env/`、[secrets](../operations/secrets.md)                        | 1Password admin console / invoice         |
| Anthropic（Claude）      | 開発エージェント（Claude Code）、月次改善ループ（gardening、ローカル session で実施。Routine は不使用）    | `CLAUDE.md`、`.claude/`                                                                             | claude.ai / Anthropic console             |
| OpenAI（ChatGPT）        | 情報収集、GitHub の Codex review（PR の標準独立レビュー。追加 reviewer は停止中。規則は `AGENTS.md` 参照） | `AGENTS.md`                                                                                         | ChatGPT settings                          |
| Vercel Registrar         | `dayopt.app`の登録・更新・nameserver設定（DNSレコード自体はCloudflareが保持）                              | [infra.md §DNS管理](../engineering/infra.md#dns-管理cloudflare)                                     | Vercel dashboard / invoice                |

## 更新ルール

- 新しい runtime SaaS を導入したら、実装と同じ変更でこの表と関連する operations docs を更新する。
- 解約や移行は行を黙って消さず、該当ドメインの `log/` に判断を残してから現行表を更新する。
- 金額、workflow 数、プラン上限など変動する値をこのファイルへ複製しない。
- 開発時だけ使う Context7、Storybook MCP などは runtime 契約に含めない。
- Anthropic / OpenAI は product runtime 依存ではない（製品コードが API key を消費せず、AI 連携はユーザーが選ぶ MCP / API client 側で行う）。ただし開発・運用の契約としては本表に載せる。

関連: [business model](../business/business-model.md) / [tooling](../operations/tooling.md) / [environment and secrets](../operations/secrets.md)
