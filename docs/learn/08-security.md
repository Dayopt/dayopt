---
status: current
last_verified: 2026-09-21
---

# 8. セキュリティ（信頼境界と攻撃面）

## この章で答えられるようになる問い

- Dayopt で「信用しない側」から「信用する側」へ入る境界はどこか
- 過去に何度も繰り返した穴の種類は何か
- 「まだ調べていない」境界はどこか（安全と混同しない）

## 概念

**信頼境界**: 信用できない主体（匿名の外部、別のユーザー、OAuth クライアント、メールのリンクを踏む誰か）が、信用する側へ入ろうとする場所。守りは境界ごとに 1 つの「検証点」に集める。

**攻撃者モデル**: Dayopt が想定するのは、匿名の外部・正規のアカウントを 1 つ持つ利用者・登録済みの OAuth クライアント・利用者が踏むリンクを用意できる第三者。Vercel / Supabase / 1Password の内部権限は攻撃者に無いものとする。

## Dayopt ではどうなっているか

認証境界で洗い出した 6 つの信頼境界:

| 境界                                        | 検証点                                                 | 経路                                                                               |
| ------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 未認証の外部 → 保護された画面               | `proxy.ts`                                             | [ログイン](journeys/login.md)                                                      |
| 未認証の外部 → tRPC                         | `protectedProcedure`                                   | [Plan を保存](journeys/save-plan.md)                                               |
| 第二要素を通していない本人 → MFA が要る操作 | MFA assurance の解決                                   | [ログイン](journeys/login.md)                                                      |
| 外部 MCP クライアント → 利用者のデータ      | `lib/oauth-server/**` と `/api/mcp`                    | [AI クライアントから Plan を作る](journeys/mcp.md)                                 |
| メールの受信者 → セッション                 | `auth/confirm`・`auth/callback`・redirect の allowlist | [サインアップ](journeys/signup.md)、[パスワード再設定](journeys/password-reset.md) |
| 利用者 → 別の利用者のデータ                 | RLS・`userId` の絞り込み・cache の利用者分離           | [3. DB / Auth / RLS](03-data-auth-rls.md)                                          |

**繰り返した穴のクラス**（再発したものだけ。網羅ではない）の中で、最も多いのは次の 2 つ。

1. **認可の判断材料が、判断される当人の側にある**（6 回）— 例: 利用者が書き換えられる値を、権限の判断に使ってしまう
2. **ガード自身の走査範囲に穴がある**（8 回）— 例: 検査スクリプトが一部のファイルや経路を見ていない

ほかに、URL の正規化ずれによる allowlist の迂回、外部由来の文章を機械が読む場所へ枠なしで流す、認可の境界より長生きする保管先が利用者ごとに分かれていない（例: MFA の cookie 改竄、#2047。`mfa-aal-cookie-tampering.integration.test.ts` がその再発防止）、など。

**まだ sweep していない境界**: 課金（Stripe webhook・利用権）、外部カレンダー（Google OAuth・token の回転・revoke outbox）、cron の 4 本、ガードレール自身、`apps/web`。**「見て問題なし」ではない**。

## 手を動かして確かめる

- [Lab: 別の利用者のデータへ手を伸ばす](labs/break-isolation.md)

## 境界に触る変更の時

- 認証・認可・RLS・OAuth・webhook・課金・migration に触る変更は、push 前に敵対的なセルフレビューを行う（AGENTS.md の lane 運用）
- `security` skill の観点（OWASP Top 10）で読む
- レビューの重点は REVIEW-1（利用者・テナント分離）と REVIEW-3（外部契約の後方互換）

## 正本

- [docs/engineering/threat-model.md](../engineering/threat-model.md) — 信頼境界・資産・攻撃面・既往クラス・却下記録・未検査の境界
- [docs/engineering/invariants.md](../engineering/invariants.md) — 不変条件の本文
- [docs/operations/security.md](../operations/security.md)

## 自分で確かめる問い

<details>
<summary>1. ログイン後の遷移先を `?redirect=` から決めている。何を確かめるか</summary>

外部 URL・`//`・バックスラッシュ・エンコードした迂回を拒否しているか（`getSafeRedirectPath`）。拒否できないとオープンリダイレクトになる（URL 正規化ずれのクラス）。

</details>

<details>
<summary>2. 「この API は aal2 が必要か」を client から渡される値で判断してよいか</summary>

よくない。「認可の判断材料が当人の側にある」クラスそのもの。server で検証した値（Supabase の factor）から判断する。

</details>

<details>
<summary>3. Stripe webhook の境界は安全か</summary>

未検査。threat-model の「未検査の境界」に入っている。署名・identity・冪等 claim の仕組みはあるが、sweep は回していない。

</details>

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": "docs/engineering/threat-model.md",
    "find": "## 未検査の境界"
  },
  {
    "path": "docs/engineering/threat-model.md",
    "find": "認可の判断材料が、判断される当人の側にある"
  },
  {
    "path": "apps/product/src/lib/safe-redirect.ts",
    "find": "getSafeRedirectPath"
  },
  {
    "path": "apps/product/src/lib/test/integration/mfa-aal-cookie-tampering.integration.test.ts",
    "find": "MFA AAL cookie tampering (#2047)"
  }
]
```
