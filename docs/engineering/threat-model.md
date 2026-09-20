---
status: current
last_verified: 2026-09-20
---

# Threat Model

`security-sweep` skill が scope を決める時と、`security` skill が実装前に既往を照合する時の参照先。
明示的な `security-sweep` では、このファイルを context / source として researcher・critic が参照する。

**このファイルは全体の脅威モデルではない。** 1 つの信頼境界ずつ、実際に sweep を回した範囲だけを書く。
書かれていない境界は「安全」ではなく **未着手**。所見ゼロを clean と読む前に §未検査の境界 を見る。

不変条件そのものの正本は [invariants.md](./invariants.md)。ここには重複させず、境界・資産・攻撃者と、
sweep が実際に得た既往クラス・却下記録を置く。

| 項目         | 値                                                              |
| ------------ | --------------------------------------------------------------- |
| 対象境界     | 認証境界（1 件目）                                              |
| 攻撃面の照合 | 2026-09-10、`7562ab0ba` 時点のコードと突き合わせ                |
| 既往クラス   | 7 クラス（2026-09-17 収集、#2709）                              |
| 却下記録     | 3 件（#2617 のパネル却下を `194afc390` で引き直し、2026-09-17） |

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

**入口となる route**（`app/**/route.ts` のうち、この境界に属するもの。全数と method の一覧は [`data/system-surface.md`](./data/system-surface.md) の生成表を見る）:

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
- `apps/product/src/lib/oauth-server/`（test を除く全モジュール）— `authorize-validation`、`code-exchange`、`redirect-uris`、`scopes`、`tokens`、`token-rate-limit`、`identity`、`clients`、`origin`、`request-host`

**データ側**: `mfa_recovery_codes`、`oauth_audit_log`、`oauth_authorization_codes`、`oauth_connections`、
`oauth_tokens`、`profiles`、`user_settings`（RLS の実効値は
[rls-snapshot.md](./data/db/rls-snapshot.md) が正本）。

**この境界の中で、まだ sweep を回していない範囲**:

- `supabase/migrations/**` と `supabase/functions/**`（SQL 側の SECURITY DEFINER / search_path）
- `app/api/v1/calendar/[token]`（token ベースの無認証 ICS。protected path glob の外）
- `app/api/csp-report`（無認証の入力口。protected path glob の外）
- Supabase Auth の設定値そのもの（`production-auth-config-audit.mjs` が別途 drift を見る）
- `app/[locale]/**/_composition/**`（Provider の設置と client 側の配線）。2026-09-10 の pilot で
  ここを scope から外した結果、client 側キャッシュの候補が終端を確定できず `undetermined` に
  なった。この境界を sweep する時は判定モジュールと一緒に入れる

---

## 既往クラス

Dayopt で実際に起きた欠陥のクラス。researcher の `class` はここにある語を使う（`class` は候補 id の
hash 入力なので、同じ欠陥に別の語を当てると同一候補として追えなくなる）。

**網羅ではない。再発したクラスだけを載せる。** 収集元は `quality:security` の issue 一覧、#2617 の
仕分け、2026-06 以降の commit に限る（2026-09-17 収集、#2709）。ここに無いクラスが安全なのではなく、
「2 回以上繰り返していない」だけ。

| クラス                                                 | 実例                                                          | 修正で閉じた場所                                           | 再発 | class ごと閉じる設計                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 認可の判断材料が、判断される当人の側にある             | #2618 / #1445 / #1448 / #1440 / #1772 / #1715                 | DB（GRANT 剥奪 + policy 削除 + service_role RPC）、service | 6    | 当人が書ける保管先を credential・権限の判断材料にしない。DB 側を deny-all 既定にし、`rls:snapshot:check` と #2683 の日次 drift 検査で維持する |
| ガード自身の走査範囲に穴がある                         | #1949 / #1953 / #1986 / #2566 / #2557 / #2509 / #2552 / #2559 | ガードレール（`scripts/hooks/**`、`scripts/ci/**`）        | 8    | 入口の allowlist を足し続けない。#2293 の前例どおり、出力段・到達点で class ごと止める形へ寄せる                                              |
| 外部由来テキストを機械可読チャネルへ枠なしで流す       | #1774 / #1775 / #1779 / #1778 / #1776                         | service（唯一の成功経路へ枠付けを集約）                    | 5    | 出力の組み立てを 1 関数へ集約し、経路が増えても枠が外れないようにする（`_tools/tool-result.ts` が前例）                                       |
| URL / origin の正規化ずれで allowlist を迂回           | `6b89325f0` / #1441 / #1449 / #1460 / #2616（未解決）         | 入口（`proxy.ts`）、Supabase Auth の設定値                 | 4    | 判定関数を個別に直さない。入口 1 箇所で decode・正規化を終えてから判定へ渡す（`6b89325f0` の commit 本文が前例）                              |
| 事前認証で到達できる経路に量的上限と失効が無い         | #2460 / #1978 / #1979 / #2081                                 | RLS（Storage）、service（rate limit）                      | 4    | 認証前に到達する経路を足す時は、上限と失効を同じ変更に含める                                                                                  |
| 認可境界より長生きする保管先がユーザー非分離           | #2619 / #2047 / #1777                                         | UI（Provider + store）、service（SSR context）             | 3    | key と中身の両方を user id で束縛し、サインアウトと主体の切り替わりで破棄する                                                                 |
| authority fence が NULL の行を writer 側だけが拒否する | #2620 → #2673（未解決）                                       | service（破壊的経路だけ例外化）                            | 2    | 読み取り側へ例外を足すのではなく、接続の作成経路で fence を必ず張る（#2673 手順 2）                                                           |

不変条件そのものは [invariants.md](./invariants.md) が正本。ここは「同じ穴を掘る前に止まる」ための索引で、
規則の本文は重複させない。

## 却下記録

過去の sweep で却下した候補。**将来のスキャンを無条件に免除するルールではない。**
再評価条件に当たった候補は、過去に却下済みでも **ACTIVE な候補として再び上げる**。
別 SHA で同じ signature が再出現した場合も同じ扱いにする（回帰の可能性を握り潰さない）。

以下 3 件は #2617 のパネルが全会一致（0/3）で却下したもの。**過去の AI 判定をそのまま採らず、
`194afc390` でコードを引き直した**（2026-09-17、#2709）。引き直しで判明した差分は各行に書く。

### C3 — MCP の機械可読チャネルへ未信頼テキストが枠なしで載る

| 項目           | 内容                                                                                                                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidateId    | C3（run `CLAUDE-SECURITY-20260906-035940`）                                                                                                                                                                                                                                                                           |
| targetSha      | `49219c8`（引き直し: `194afc390`）                                                                                                                                                                                                                                                                                    |
| 成立前提       | read tool の description すべてに `MCP_UNTRUSTED_CONTENT_NOTICE` が付き、かつ `createMcpToolSuccess` が唯一の成功経路であること                                                                                                                                                                                       |
| 反証           | `apps/product/src/app/api/mcp/_tools/tool-result.ts` の doc コメントが設計判断を明示する — 枠付けを個々の tool へ置くと read tool を足すたび漏れるので唯一の成功経路へ寄せ、`structuredContent` は outputSchema 検証を通る機械可読チャネルなので枠を付けない。呼び出し前の client は description の注意書きを受け取る |
| 引き直しの差分 | 却下時の本文は「全 12 read tool」と書くが、`194afc390` では注意書きの利用箇所は 7 ファイル 10 箇所。**件数は前提に使わない**（tool 数と呼び出し箇所数のどちらを数えたか確定できないため）。構造の前提（description 側で配布、`tool-result.ts` が唯一経路）は成立したまま                                              |
| 再評価条件     | (1) `_tools/` に注意書きを持たない read tool が増える（**lint / test の強制は無い。手で文字列を差し込む形**）(2) `tool-result.ts` が成功経路を分岐させる、または `content` の text を落とす (3) 注意書きの文言が変わる                                                                                                |

### C10 — リカバリコードのハッシュ強度（40 bit）

| 項目           | 内容                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidateId    | C10（同 run）                                                                                                                                                                                                                                                                             |
| targetSha      | `49219c8`（引き直し: `194afc390`）                                                                                                                                                                                                                                                        |
| 成立前提       | pepper が DB から到達できない必須 env secret であり続けること。ここが崩れると CWE-916 の想定攻撃者が候補を試せるようになる                                                                                                                                                                |
| 反証           | `apps/product/src/lib/auth/recovery-codes.ts` の `getHmacPepper()` が未設定なら throw し、`apps/product/src/env.ts` の production refine が本番で必須にし、`apps/product/production-build-gate.mjs` の必須 env 一覧が deploy 前に落とす。DB ダンプだけを持つ攻撃者は候補を 1 つも試せない |
| 引き直しの差分 | 却下時の本文は `scripts/ci/production-build-gate.mjs` を引いているが**その path は存在しない**。実体は `apps/product/production-build-gate.mjs`（および `apps/web` の同名ファイル）。反証の中身は成立するが、参照先を訂正した                                                             |
| 再評価条件     | (1) pepper が DB から到達できる保管先へ移る (2) production refine か build gate の必須 env 一覧から外れる (3) `hashRecoveryCode` 以外のハッシュ経路が増える (4) #2115 のような pepper 欠落・漏洩が起きる                                                                                  |
| 混同しないこと | この却下は「リカバリコードは安全」ではない。同じ保管先について**認可**の側は #2618 で HIGH が確定している（当人が INSERT できた）。閉じたのは認可であって、ハッシュ強度の議論とは別                                                                                                       |

### cron の共有 secret に長さ下限が無い

| 項目           | 内容                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidateId    | 新規候補（id 未採番、同 run）                                                                                                                                                                                                   |
| targetSha      | `49219c8`（引き直し: `194afc390`）                                                                                                                                                                                              |
| 成立前提       | 認可が定数時間の**完全一致**であり続けること。長さ下限の有無は認可の強度を決めない                                                                                                                                              |
| 反証           | `apps/product/src/app/api/cron/calendar-sync/route.ts` は未設定なら 503 で返し、設定時は `safeEquals` で `Bearer <secret>` 全体を `timingSafeEqual` に掛ける。攻撃者は決め手になる入力を書けない                                |
| 引き直しの差分 | パネルが報告しなかった事実として、**4 本の cron route のうち下限を持たないのはこの 1 本だけ**（他 3 本は `MIN_CRON_SECRET_LENGTH = 16` を持つ）。`env.ts` の側にも下限は無い。到達可能な failure ではなく規約の不揃いとして扱う |
| 再評価条件     | (1) 完全一致が前方一致・部分比較へ変わる (2) 短い値を生成しうる `CRON_SECRET` の発行経路が増える（下限は 3 route 側にあり schema 側に無い）(3) この route に第 2 の認証経路が増える                                             |

### 境界横断の検証で否定した疑い（2026-09-20、`048a8ce`）

sweep ではなく、「境界をまたいだ時に成立しない条件」を探す単発の敵対的検証（PR で記録）。
`security-sweep` の pack / envelope は通していないので、上の 3 件と同じ却下記録の扱いにはしない。
ここに書くのは **将来のセッションが同じ疑いを掘り返さないため**の反証であり、免除ではない。
同じ検証で確認できた問題は E-1（transient bounce の恒久 suppression）/ O-9（終了後の UI gating）/
O-6（`billing-reconciliation` の heartbeat 欠落）として同 PR で修正し、D-1（Privacy Policy の
30 日 export 窓 vs 即時削除、#2857）/ D-2（`email_suppressions` が削除後も残る、#2859）/ E-2（MFA 無効化通知の
非対称、#2858）は issue にした。法務ページの他の stale 記述は #2860、repo から確定できなかった運用側の
3 点は #2861。

| 疑い                                                                                        | 成立前提                                                                 | 反証（`048a8ce`）                                                                                                                                                                                                                                                  | 再評価条件                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| MCP read tool に tenant isolation の case が無いものがある                                  | `_tools/*.ts` が呼ぶ tRPC procedure が test の case より多い             | `_tools/*.ts` が呼ぶのは 8 procedure（activities.listActivities / listCategories、plans.list / getById、records.list / getById、statistics.getMcpReview、timeblockContext.getConstraints）で、`mcp-read-tenant-isolation.integration.test.ts` は全てに case を持つ | read tool を足す時（invariants.md §MCP の規約どおり case を足す）                          |
| DT005 の `SESSION_USER NOT IN ('postgres','supabase_admin')` 免除を service-role 経路が通る | PostgREST の service-role 接続で SESSION_USER が免除対象になる           | PostgREST は `authenticator` で接続し `SET ROLE` するため SESSION_USER は `authenticator` のまま。免除は migration / seed 用                                                                                                                                       | pooler や Edge Function から `postgres` ロールで直接 DML する経路が増えた時                |
| cron の calendar sync が利用権の切れた利用者にも走る                                        | dispatcher が entitlement を見ない                                       | `sync-dispatcher.ts:126-148` が enforced 時に `checkEntitlementForUser` で skip し、`sync-service.ts:214-216` 等で多重に再検査する                                                                                                                                 | dispatcher の entitlement 分岐を触る時                                                     |
| Upstash 未設定で `password-reauthentication.ts:73` の rate limit が fail-open になる        | production で Upstash env が欠けたまま起動できる                         | `env.ts:186-203` の production refine、`production-build-gate.mjs:15-31`、`production-config-audit.mjs:7` の 3 層が build 前に落とす。null 素通り自体は事実                                                                                                        | この 3 層のどれかから Upstash が外れた時                                                   |
| `email_change` の旧 address 通知が `token_hash_new` 依存で黙って落ちる                      | `mailer_secure_email_change_enabled` が production で false になっている | `production-auth-config-audit.mjs:127` が `true` を pin し drift を検出する（audit は「落ちても操作を止めない」意味で fail-open。無監視ではない）                                                                                                                  | audit の対象 key から外れた時、または Edge Function が `token_hash_new` 以外を条件にした時 |
| `custom_access_token_hook` が production で無効なため claim 欠落で認可が壊れる              | JWT の `subscription_status` claim を読む認可経路がある                  | `trpc/context.ts:203-221` が `ctx.subscriptionStatus` を組み立てるが読み手が無く、認可は全て `getBillingAccess` が profiles を読む。無効は #1946 の意図的判断                                                                                                      | `ctx.subscriptionStatus` の読み手が増えた時                                                |
| 公開 docs の Free / Pro・7 日体験の表記が実装（単一プラン・45 日）と食い違う                | 公開文言が誤って取り残されている                                         | `docs/operations/billing-single-plan-rollout.md:31` が「flag flip まで Web は旧表記を保つ」と明記した意図的保留                                                                                                                                                    | `BILLING_ENFORCED=true` を配備する時（同時に Web を更新する）                              |
| Stripe `customer.deleted` / `customer.updated` が未処理で durable mode が 500 を返し続ける  | endpoint がそれらの event を購読している                                 | 購読 event は `docs/product/specs/billing.md:77-81` の 5 種に明示限定（`runbook.md` の一覧に `invoice.paid` が欠けていたのは同 PR で直した）                                                                                                                       | endpoint の購読 event を増やす時                                                           |
| `BILLING_ENFORCED` に production guard が無く、欠落 deploy で課金が黙って外れる             | 現在 production で `true` である                                         | 現在は rollout 前で意図的に `false`（`billing-single-plan-rollout.md:31`）。flip 時に `production-config-audit.mjs` の required へ足す手順が rollout doc に無いことは #2861 に残した                                                                               | rollout 実施時                                                                             |

**この検証で見ていない範囲**: `supabase/functions/**` の send-auth-email 以外、Stripe / Resend の
dashboard 側設定（endpoint の振り分け、購読 event の実値）、GoTrue の production 設定値そのもの、
`apps/web` の LP / blog。integration test は実行環境（local Supabase 無し）の制約で **作成のみ**で、
CI の integration job で初回実行される。

## 未検査の境界

次の境界はまだ sweep を回していない。**「見て問題なし」ではない。**

- 課金境界（Stripe webhook、entitlement、`lib/billing/**`）
- 外部カレンダー境界（Google OAuth、token rotation、revoke outbox、account deletion settle）
- cron 境界（`api/cron/**` の 4 本。`calendar-sync` / `external-connection-maintenance` /
  `calendar-account-deletion-settle` / `billing-reconciliation`）
- ガードレール自身（`scripts/ci/**`、`.husky/**`、`scripts/hooks/**`）
- `apps/web`（LP / docs / blog）
