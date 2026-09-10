---
status: current
last_verified: 2026-09-10
---

# Threat Model

`security-sweep` skill が scope を決める時と、`security` skill が実装前に既往を照合する時の参照先。
`pr-cross-review` の `risk-reviewer` も `--source` でこのファイルを受け取る。

**このファイルは全体の脅威モデルではない。** 1 つの信頼境界ずつ、実際に sweep を回した範囲だけを書く。
書かれていない境界は「安全」ではなく **未着手**。所見ゼロを clean と読む前に §未検査の境界 を見る。

不変条件そのものの正本は [invariants.md](./invariants.md)。ここには重複させず、境界・資産・攻撃者と、
sweep が実際に得た既往クラス・却下記録を置く。

| 項目         | 値                                                                        |
| ------------ | ------------------------------------------------------------------------- |
| 対象境界     | 認証境界（1 件目）                                                        |
| 攻撃面の照合 | 2026-09-10、`7562ab0ba` 時点のコードと突き合わせ                          |
| 既往クラス   | **未収集**（最初の sweep の評価入力に答えを混ぜないため、評価後に埋める） |
| 却下記録     | **未収集**（同上）                                                        |

---

## 境界 1: 認証境界

### 信頼境界

| 境界                                   | 越える主体                             | 検証点                                                  |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| 未認証の外部 → アプリの保護ルート      | ブラウザ（cookie 有無を問わない）      | `proxy.ts` と `lib/supabase/middleware.ts`              |
| 未認証の外部 → tRPC                    | ブラウザ、スクリプト                   | `protectedProcedure` と `lib/trpc/session-auth-context` |
| aal1 セッション → aal2 限定の操作      | 認証済みだが第二要素を通していない本人 | MFA assurance の解決と SECURITY DEFINER RPC             |
| 外部 MCP クライアント → ユーザーデータ | OAuth クライアント（Claude 等）        | `lib/oauth-server/**` と `api/mcp`                      |
| メール受信者 → セッション              | メールのリンクを踏む主体               | `auth/confirm`、`auth/callback`、redirect allowlist     |
| 認証済みユーザー → 他ユーザーのデータ  | 本人                                   | RLS、`userId` フィルタ、cache のユーザー分離            |

**攻撃者モデル**: 匿名の外部、正規のアカウントを 1 つ持つ利用者、登録済みの OAuth クライアント、
ユーザーが踏むリンクを用意できる第三者。インフラ（Vercel / Supabase / 1Password）の内部権限は
攻撃者に無いものとする。

### 資産

| 資産                                                               | 失われると何が起きるか                     |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Supabase セッション（cookie）と AAL claim                          | 本人になりすませる                         |
| `mfa_recovery_codes`（deny-all + SECURITY DEFINER RPC）            | 第二要素を迂回できる                       |
| `oauth_tokens` / `oauth_authorization_codes` / `oauth_connections` | 外部クライアントとして他人のデータを読める |
| `CRON_SECRET`、webhook 署名鍵                                      | 内部処理を外部から起動できる               |
| `profiles` / `user_settings` と予定・記録の本体                    | テナント越境の読み書き                     |
| ブラウザに永続化した tRPC cache                                    | 同一端末の前ユーザーのデータが見える       |

### 攻撃面（`7562ab0ba` 時点で実測）

**入口となる route**（`app/**/route.ts` の全 19 本のうち、この境界に属するもの）:

| path                                         | 認証                                |
| -------------------------------------------- | ----------------------------------- |
| `app/api/oauth/token/route.ts`               | 未認証（client credential と code） |
| `app/oauth/token/route.ts`                   | 同上（別 mount）                    |
| `app/api/mcp/route.ts` / `app/mcp/route.ts`  | OAuth bearer                        |
| `app/[locale]/(auth)/auth/callback/route.ts` | 未認証（code 交換）                 |
| `app/[locale]/(auth)/auth/confirm/route.ts`  | 未認証（token_hash）                |
| `app/api/trpc/[trpc]/route.ts`               | セッション（procedure ごと）        |
| `app/api/v1/calendar/[token]/route.ts`       | token のみ（公開 ICS）              |

`.well-known/oauth-authorization-server` と `.well-known/oauth-protected-resource` は metadata を返す
未認証エンドポイント。

**判定を持つモジュール**:

- `apps/product/src/proxy.ts` — 保護ルートの判定と MFA redirect
- `apps/product/src/lib/supabase/middleware.ts` — セッション更新
- `apps/product/src/lib/trpc/session-auth-context.ts` — verified user / session token / MFA assurance の共通解決
- `apps/product/src/lib/auth/domain/access-policy.ts`、`permissions.ts`、`roles.ts`
- `apps/product/src/lib/auth/recovery-codes.ts`、`session-config.ts`、`pwned-password.ts`
- `apps/product/src/lib/safe-redirect.ts` — redirect allowlist
- `apps/product/src/lib/oauth-server/`（test を除く 18 モジュール）— `authorize-validation`、`code-exchange`、`redirect-uris`、`scopes`、`tokens`、`token-rate-limit`、`identity`、`clients`、`origin`、`request-host`

**データ側**: `mfa_recovery_codes`、`oauth_audit_log`、`oauth_authorization_codes`、`oauth_connections`、
`oauth_tokens`、`profiles`、`user_settings`（RLS の実効値は
[rls-snapshot.md](./data/db/rls-snapshot.md) が正本）。

**この境界の中で、まだ sweep を回していない範囲**:

- `supabase/migrations/**` と `supabase/functions/**`（SQL 側の SECURITY DEFINER / search_path）
- `app/api/v1/calendar/[token]`（token ベースの無認証 ICS。protected path glob の外）
- `app/api/csp-report`（無認証の入力口。protected path glob の外）
- Supabase Auth の設定値そのもの（`production-auth-config-audit.mjs` が別途 drift を見る）

---

## 既往クラス

**未収集。** 最初の sweep（#2588）の検出品質を評価する入力に答えを混ぜないため、評価が終わるまで空にする。

埋める時は 1 クラスにつき次を書く。

- クラス名（researcher の `class` と同じ語を使う）
- 実例の issue 番号と、修正で閉じた場所（DB trigger / RLS / service / UI のどれか）
- 再発回数。2 回以上なら「点を塞ぐ」でなく「class を閉じる」設計へ転換できないかを併記する

## 却下記録

**未収集。** 同上。

埋める時は 1 件につき次を書く。**将来のスキャンを無条件に免除するルールにはしない。**

| 項目        | 内容                                                             |
| ----------- | ---------------------------------------------------------------- |
| candidateId | sweep の候補 id                                                  |
| targetSha   | どの SHA のコードに対する判断か                                  |
| 成立前提    | 何が真である限り却下が成り立つか                                 |
| 反証        | どの source のどの記述で否定できるか（コード引用）               |
| 再評価条件  | どの path が変わったら、どの前提が崩れたら、再び候補として扱うか |

再評価条件に当たった候補は、過去に却下済みでも **ACTIVE な候補として再び上げる**。
別 SHA で同じ signature が再出現した場合も同じ扱いにする（回帰の可能性を握り潰さない）。

## 未検査の境界

次の境界はまだ sweep を回していない。**「見て問題なし」ではない。**

- 課金境界（Stripe webhook、entitlement、`lib/billing/**`）
- 外部カレンダー境界（Google OAuth、token rotation、revoke outbox、account deletion settle）
- cron 境界（`api/cron/**` の 3 本）
- ガードレール自身（`scripts/ci/**`、`.husky/**`、`scripts/hooks/**`）
- `apps/web`（LP / docs / blog）
