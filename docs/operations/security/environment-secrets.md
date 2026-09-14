---
status: current
last_verified: 2026-08-14
---

# Environment Secrets

Dayopt の Secrets 運用の正本は [Operations / Secrets](../secrets.md)。
このページでは GitHub / Vercel / Supabase 側に置かれる replica の役割だけを整理する。

## 基本方針

- 1Password は production / shared / optional staging の長寿命 secrets の master
- Vercel Env、GitHub Secrets、Supabase Dashboard secrets は replica
- PR Preview 用 Supabase credentials は Supabase / Vercel integration が作る ephemeral replica
- PR Preview credentials は 1Password に保存しない
- 値の確認は存在確認だけにし、terminal / docs / issue / chat に出さない

## GitHub

GitHub Actions は lint / typecheck / test / build などの検証を担当する。
Supabase migration の production 適用は GitHub Actions ではなく Supabase GitHub integration が担当する。

GitHub branch protection では、通常の CI check に加えて Supabase integration の Preview Branch check を required にする。

| Secret                             | 用途                                         | 方針                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_AUTH_AUDIT_TOKEN`        | Production Auth Config Audit                 | 1Password `ci/supabase-auth-audit`（field `credential`）の replica。Auth の Read のみの scoped token。auth-config job の 1 step だけへ渡す                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SUPABASE_STORAGE_RLS_AUDIT_TOKEN` | Production Storage RLS Audit                 | 1Password `ci/supabase-storage-rls-audit`（field `credential`）の replica。`database_read` のみの scoped token。storage-rls job の 1 step だけへ渡す。**2026-08-25（[#2345](https://github.com/Dayopt/dayopt/issues/2345)）に発行・GitHub Secret 登録済み。** 未設定になった場合（誤削除・失効等）は audit script が即 throw する（2026-08-28、[#2449](https://github.com/Dayopt/dayopt/issues/2449)。発行前は `::notice::` + exit 0 で許容していたが、発行済み後にその分岐を残すと「token 消失時に audit が黙って緑になる」false-green 経路になるため廃止した） |
| `VERCEL_TOKEN`                     | Production Config Audit / Production Release | env metadata読取、Production promote / rollback、promoteの副作用で戻るproject設定の復元に限定                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `VERCEL_ORG_ID`                    | Production Config Audit / Production Release | 1Password `ci/vercel-production` の `VERCEL_TEAM_ID` の GitHub replica                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `VERCEL_AUTOMATION_BYPASS_PRODUCT` | Production Release smoke                     | Product の Protection Bypass for Automation。master は `ci/vercel-production`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `VERCEL_AUTOMATION_BYPASS_WEB`     | Production Release smoke                     | Web の Protection Bypass for Automation。master は `ci/vercel-production`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

この表は「workflow が参照する実在 secret」と 1:1 を意図する（GitHub が自動発行する `secrets.GITHUB_TOKEN` は対象外。2026-08-14 に実測と突き合わせ、実在しない 3 行 `CODECOV_TOKEN` / `LHCI_GITHUB_APP_TOKEN` / `SUPABASE_ACCESS_TOKEN` を削除した）。workflow 未参照だった 6 件（`APP_WEB_REPO_TOKEN` / `ORG_ID` / `PROJECT_ID` / `VERCEL_PROJECT_ID` / `SENTRY_ORG` / `SENTRY_PROJECT`）は同日 User 裁可のうえ削除した（[#2090](https://github.com/Dayopt/dayopt/issues/2090)。`SENTRY_ORG` / `SENTRY_PROJECT` は 1Password の `human/sentry*` に同名 field が実在、ID 系 3 件は公開 metadata で復元可、`APP_WEB_REPO_TOKEN` は旧 PAT の残骸で発行元 token の失効確認を #2090 に残した）。

### `SUPABASE_STORAGE_RLS_AUDIT_TOKEN` の単発ローカル実行（merge 前の実測など）

策定日: 2026-08-28（[#2449](https://github.com/Dayopt/dayopt/issues/2449)）。`storage-rls` job は `push:main` / `schedule` でしか走らないため（CI 経路では PR branch 上で production 実測ができない）、merge 前に drift の有無を確かめたい場合は、User の明示指示のもと 1Password の `ci` vault から直接 `op run` で読み出して実行する:

```bash
SUPABASE_STORAGE_RLS_AUDIT_TOKEN="op://ci/supabase-storage-rls-audit/credential" \
  op run -- node scripts/ci/production-storage-rls-audit.mjs
```

- token は `ci` vault にある（`human` vault ではない）。agent の vault allowlist は `agent` のみのため、**この実行自体は agent 単独では行えず、User の明示指示（1Password 承認）を経由する**
- script の標準出力は pass/fail のメッセージのみで生の query 結果を出さないため、出力をそのまま issue / PR へ貼ってよい（jq 射影は不要）
- CI 経路（`push:main` / 日次 cron）が本来の継続監視であり、この単発実行は「merge 前に前倒しで 1 回確認したい」時の例外的な手段

GitHub Actions の通常 build は release / source map upload を行わないため、Sentry metadata と `SENTRY_AUTH_TOKEN` を渡さない。

`VERCEL_TOKEN`をlocal CLIの`--token`引数へ渡さない。Vercel CLIはpaginationなどの再実行案内に引数値を含める場合がある。localのmetadata確認はconnector、Dashboard、または対話login済みCLIを使う。Production Config AuditとProduction Releaseは1Password masterから同期したGitHub replicaを環境変数で受け取り、process内でAuthorization headerにだけ設定する。Protection Bypass secretも同様に、smoke requestのheaderにだけ設定してlogやerror messageへ出さない。例外: `pnpm replica:check`（[Operations / Secrets](../secrets.md) §Verification）はlocalから`VERCEL_TOKEN`を使うが、1Passwordから環境変数で受け取りAuthorization headerにだけ設定する同じ形であり、`--token`引数には渡さない。

露出が疑われる場合は値を表示・比較せず、replacement作成 → 1Password master更新 → GitHub replica更新 → trusted branchでProduction Config Audit成功確認 → 旧token revokeの順でrotateする。旧tokenを先にrevokeするとauditとProduction Releaseの両方が止まるため、この順序を崩さない。事故記録はVercel CLI token出力 incident（削除済み、git 履歴参照）を参照する。

## Vercel

| Environment | Supabase credentials                                        |
| ----------- | ----------------------------------------------------------- |
| Production  | `human/supabase` から手動同期した replica                   |
| Preview     | Supabase Vercel integration が PR branch credentials を注入 |
| Development | 通常は使わない。local は `.op-env.agent` + `op run`         |

Preview scope に production Supabase credentials を手動設定しない。
既に入っている場合は削除するか、Preview から外して Supabase integration 管理に寄せる。

### Sentry

`product` と `web` は別 Sentry project を使う。両Vercel projectでenv名は共通だが、`NEXT_PUBLIC_SENTRY_DSN`、`SENTRY_DSN`、`SENTRY_PROJECT`は各project固有の値とする。`SENTRY_ORG`とbuild tokenは共通でよい。

| Vercel target | Sentry env                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| Production    | 5変数すべて。`SENTRY_AUTH_TOKEN`はSensitive、残りは公開metadata / DSNとして扱う |
| Preview       | 設定しない。runtime、release作成、source map uploadを行わない                   |
| Development   | 設定しない。localもSentryへ送信しない                                           |

Production replicaはProductが`human/sentry`、Webが`human/sentry-web`をmetadata / DSNのmasterとする。build tokenだけは`human/sentry-login`の単一fieldを両projectへ同期する。

2026-07-16 のVercel確認では、Product / Webとも5変数をProductionだけに設定し、Preview / DevelopmentにはSentry envがないことを確認した。1Password CLIは未認証だったため、上記item / fieldが実在し空でないことは未確認である。master側の確認と不足fieldの整理はblocked中の[#1558](https://github.com/Dayopt/dayopt/issues/1558)で行い、確認前に推測でitemを変更しない。

### Vercel readiness audit (2026-07-14)

対象 project は Vercel team `Dayopt` の `product` と `web`。
確認は secret 値ではなく metadata と未認証レスポンスだけを見る。

#### Preview protection

| URL                                | 期待                                               | 2026-07-08 確認結果                   |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------- |
| `*.vercel.app` preview (`product`) | 未認証は Vercel SSO / Deployment Protection に送る | `302` to `https://vercel.com/sso-api` |
| `*.vercel.app` preview (`web`)     | 未認証は Vercel SSO / Deployment Protection に送る | `302` to `https://vercel.com/sso-api` |
| `app.dayopt.app`                   | production app として通常到達できる                | `200`                                 |
| `dayopt.app`                       | production marketing site として通常到達できる     | `200`                                 |
| `mcp.dayopt.app`                   | OAuth / token validation で保護される              | `401`                                 |

`product` には Automation Bypass が存在し、Vercel env var として管理されている。
値は docs / issue / PR / terminal に出さない。漏えいが疑われる場合は Vercel Dashboard で rotate し、
新しい値は 1Password か Vercel-managed secret storage だけに置く。

#### Env scope / Sensitive flag

`product` Preview に production Supabase credentials は見えない。
Supabase integration 由来の production DB / key も `production` target のみ。

2026-07-21にVercel APIで値を復号せずkey / target / typeだけを再確認した。Contact移行前の状態は次のとおりで、まだProduction契約を満たさない。

| Project   | Metadata                                 | 確認結果                                                | Merge前の対応                   |
| --------- | ---------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| `product` | `RESEND_API_KEY`                         | Production / PreviewはSensitive、DevelopmentはEncrypted | Productionだけへ限定する        |
| `product` | `RESEND_FROM_EMAIL`                      | Production / Preview / Developmentに存在                | Productionだけへ限定する        |
| `product` | `RESEND_WEBHOOK_SECRET`                  | Production Sensitive                                    | 維持する                        |
| `web`     | Resend 3変数                             | いずれも存在しない                                      | Productionへ追加する            |
| 両方      | Upstash 2変数                            | Productionに存在                                        | tokenをSensitiveのまま維持する  |
| `web`     | Turnstile 2変数                          | Productionに存在                                        | secretをSensitiveのまま維持する |
| 両方      | 旧`GITHUB_TOKEN` / `GITHUB_CONTACT_REPO` | 全scopeから削除済み                                     | 再設定をauditで常時拒否する     |

Contactの目標契約:

- Product / WebのProductionに`RESEND_API_KEY`、`RESEND_FROM_EMAIL`、app別`RESEND_WEBHOOK_SECRET`を置く
- `RESEND_API_KEY`と`RESEND_WEBHOOK_SECRET`はSensitive typeかつProduction targetだけにする
- Product / Webのwebhook secretが異なることはmetadataでは証明できないため、Resend / Vercel dashboardで値を表示せず確認する
- `RESEND_API_KEY`と`RESEND_WEBHOOK_SECRET`がPreview / Developmentにあれば`Production Config Audit`を失敗させる
- 旧`GITHUB_TOKEN` / `GITHUB_CONTACT_REPO`がどのtargetにあっても`Production Config Audit`を失敗させる

Previewは`RECOVERY_CODE_PEPPER`を維持する。production modeのenv validation / recovery code処理に必要なためである。その他のDevelopment secret cleanupは[#1558](https://github.com/Dayopt/dayopt/issues/1558)のscopeとし、Contact切替と混ぜない。

履歴はVercel environment variable scope audit（削除済み、git 履歴参照）、Contact切替の手順は[問い合わせメール運用](../contact-email.md)を参照する。

`NEXT_PUBLIC_*` と repository 名などの公開 metadata は secret 扱いにしない。
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` は public key なので、`sensitive` のままでも事故ではないが必須ではない。

`NEXT_PUBLIC_TURNSTILE_SITE_KEY` は **product / web の両 Production に必須**とする（#1924）。secret ではないが、欠落すると product 側は widget を描画しないまま signIn し、production の Supabase Auth Bot Protection が全リクエストを `captcha_failed` で拒否して login / signup / password reset が全滅する。build は成功してしまうため、`apps/product/production-build-gate.mjs` / `apps/web/production-build-gate.mjs` の必須 env と `Production Config Audit` の両方で欠落を検知する。

| Project   | Metadata                         | 契約                                            |
| --------- | -------------------------------- | ----------------------------------------------- |
| `product` | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Production に必須。`sensitive` である必要はない |
| `web`     | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 同上                                            |

## Supabase Auth config

production の Auth 設定（Bot Protection、メール変更の二重確認、匿名サインインの可否など）は **Supabase Dashboard が正本**で、`supabase/config.toml` の `[auth.*]` は local と PR Preview branch にしか効かない。GitHub integration の Deploy to production も Auth 設定を同期しない。そのため Dashboard 側でトグルが 1 つ変わると、テストも build も通ったまま安全性が消える。

期待値の正本は [`scripts/ci/production-auth-config-audit.mjs`](../../../scripts/ci/production-auth-config-audit.mjs) の `AUTH_CONFIG_CONTRACT` に置く。docs は CI を fail させられないため正本にしない。監視は `Production Config Audit` workflow の `auth-config` job が担い、**push:main と日次 cron でだけ**走る。

- PR と `workflow_dispatch` では走らせない。Management API の token は account 単位 read-write（`POST /v1/projects/{ref}/database/query` で production DB への任意 SQL を含む）で、Vercel token より blast radius が広い。`workflow_dispatch --ref <branch>` は branch head を checkout するため、この経路に token を乗せない
- GitHub secret 名は `SUPABASE_ACCESS_TOKEN` と分けて `SUPABASE_AUTH_AUDIT_TOKEN` にする。同名だと、別 workflow が「その名前を参照するだけ」で PR 側 code の実行経路へ token が配られる（`integration.yml` が実際にこの形の workflow レベル env を持っていた。2026-08-11 に削除）
- 応答には `security_captcha_secret` などの secret が同梱される。audit は `AUTH_CONFIG_CONTRACT` に列挙した **値そのものが credential になり得ない設定値**だけを読み、それ以外は出力しない。`*_secrets` / `*_key` / `*_token` / `*_pass` / `*_credentials` は契約へ入れない（contract test が名前で弾く）
- **監視対象は live 応答の全数トリアージから起こす。** 現在 31 件を pin し、`security_` / `hook_` / `mfa_` / `sessions_` / `password_` 配下で契約にも除外リストにも無いキーが現れたら failure にする（boolean に限らない — `hook_send_email_uri` は全認証メールの token 配送先で、string だが最大級の危険値）。`external_*`（95 キー）と `mailer_*`（40 キー）は provider / template が増えるたびにキーが増え、キーの存在自体は危険ではないため guard の対象外にし、危険な値だけ個別に pin する
- **audit が「unclassified」で赤くなった時の解除手順**: ① 期待値は必ず live 実測から起こす（推測を置くと恒久 failure になる）② 契約か除外リストに足したら、`scripts/__tests__/production-auth-config-audit-contract.test.ts` のリテラル固定を**同じ PR で**更新する（更新しないと無関係に見える test が落ちる）
- **監視対象は公開 OpenAPI spec から導出しない。** `https://api.supabase.com/api/v1-json` の `AuthConfigResponse` は live 応答の完全な記述ではなく、2026-08-11 実測で live 242 キーに対し spec 237 キー、6 キーが spec に無かった。その 1 つがパスワード変更が依存する `security_update_password_require_current_password` で、spec を根拠に「存在しない」と誤断した事故がある。監視対象は必ず **live 応答の `keys` 列挙**から起こす。規律を人手に頼らないため、契約にも除外リストにも無い `security_*` キーが現れたら audit が failure になる
- **判定は期待値との等値**にしてあり、片方向の警報にしない。設定が緩む方向（fail-open: 本来止まる操作が黙って通る）と締まる方向（fail-closed: 本来通る操作が黙ってできなくなる）の**どちらの drift も failure にする**。各値の `failureMode` はこの分類で、警報条件ではなく失敗時の読み解きに使う。`security_captcha_provider` と `security_update_password_require_reauthentication` は fail-closed 側で、「安全側に倒れる変更」に見えて login やパスワードリセットを止めうる

**保証境界**（`AGENTS.md §PR / git 運用` §同型指摘の打ち切り に従い明文化）。守るのは ① `security_` / `hook_` / `mfa_` / `sessions_` / `password_` 配下の**網羅性**（契約にも除外リストにも無いキーは型を問わず failure）② その外側は 2026-08-11 の全数トリアージで選んだ個別 pin ③ pin した値の**両方向**の drift。守らないのは `external_*` / `mailer_*` / `smtp_*` / `sms_*` に新しく増えるキー（キーの存在自体は危険ではなく、guard に入れると形骸化する）、値の意味の検証（死活監視ではない）、Dashboard 以外の経路で生じた状態。境界の外側に未 pin の値があるという指摘は、境界の更新提案として別 issue で扱う。

**「守らない」側は放置すると静かに腐る**（除外した名前空間に、後から安全性に効くキーが増えても気づけない）。次のどちらかを契機に再トリアージする: **月次ガーデニング**、または **Supabase の Auth 新機能を認知した時点**。手順は live 応答の `keys` 列挙を取り直し、除外名前空間に増えたキーが無いかを見るだけでよい（`security_` / `hook_` / `mfa_` / `sessions_` / `password_` 配下は audit 自身が落ちるので確認不要）。

手元での単発確認は `op run` 経由で行う（値は 1Password が masking する。`docs/operations/secrets.md` §API 経由の設定読戻し に従い、射影は完全一致で書く）:

```bash
SUPABASE_AUTH_AUDIT_TOKEN="op://ci/supabase-auth-audit/credential" op run -- node scripts/ci/production-auth-config-audit.mjs
```

#### Pre-deploy dry run

2026-07-08 時点の local Vercel CLI は `50.32.5`。
`vercel deploy --help` に `--dry` は出ていないため、`vercel deploy --dry` を pre-deploy check / CI に入れない。
CLI と公式 docs の両方で dry run が確認できた時点で、次の順で再評価する。

1. `vercel deploy --help` で `--dry` が表示されることを確認する
2. `product` と `web` で deploy されないことを確認する
3. 出力が secret 値を含まないことを確認する
4. 有用なら `pnpm` script か CI の warning-only step に入れる

## Supabase

Supabase Dashboard secrets は Supabase 側で必要な長寿命 replica として扱う。
Auth Bot Protection、Auth hooks、Edge Functions、Vault secrets は 1Password master から手動同期する。

PR Preview Branch credentials は短命で、Supabase Branching / Vercel integration が扱う。
手動で 1Password や GitHub Secrets に保存しない。

## Emergency Only

手動 `supabase db push` や linked DB reset は通常導線ではない。
Supabase integration 障害などで緊急対応が必要な時だけ、理由と対象環境を作業ログに残して実行する。

```bash
pnpm db:reset-linked:unsafe
```
