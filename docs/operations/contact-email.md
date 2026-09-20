---
status: current
last_verified: 2026-09-17
code:
  - apps/product/src/features/contact
  - apps/product/src/app/api/webhooks/resend
  - apps/web/src/app/api/contact
  - apps/web/src/app/api/webhooks/resend
  - scripts/ci/production-config-audit.mjs
---

# 問い合わせメール運用

`support@dayopt.app`の受信、返信、フォーム配送、Production切替、障害時の戻し方の正本。secret値、nameserver値、個人Gmail addressは記録しない。

## 構成

```text
通常メール → support@dayopt.app → Cloudflare Email Routing → 既存Gmail
                                                               └→ Resend SMTPでsupport@dayopt.appとして返信

Product contact.submit ─┐
                        ├→ Resend API → support@dayopt.app → 同じ運用受信箱
Web POST /api/contact ──┘

Resend delivery failure → app別POST /api/webhooks/resend → PIIなしSentry event
```

問い合わせ原文はResendの配送処理とアクセス制限付きGmailにだけ置く。logger、Sentry、HTTP response、GitHub Issueへ原文・氏名・email・Turnstile token・authorization・webhook raw bodyを記録しない。

## 役割とsecret分離

| 用途                | 1Password                                  | Replica / scope                                               |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Product / Web送信   | `human/resend-send`                        | 各Vercel projectのProductionだけ。Preview / Developmentは禁止 |
| Product webhook署名 | `human/resend`                             | Product Productionだけ                                        |
| Web webhook署名     | `human/resend-web`                         | Web Productionだけ。Productと異なる値                         |
| Gmail返信SMTP       | `human/resend-support-replies`             | Gmail Send mail asだけ。Sending access・`dayopt.app`限定      |
| 受信先Gmail         | Google accountのLogin / MFA / recovery管理 | address自体をrepoへ書かない                                   |

API keyやwebhook secretはchat、Issue、PR、docsへ貼らない。アプリ送信用keyとGmail返信用keyを共用しない。

## 重複配送をどの層で止めるか

Resendのidempotency keyは**24時間保持・256文字まで・同じkeyでpayloadが違うと409**。つまり「retryでは同じkey、別の論理通知では別key」を満たせない経路に機械的にkeyを付けると、正当な2回目の通知を黙って潰す。経路ごとに止める層を分ける（#2803）。

| 経路                                                        | retryの発生源                                 | 止める層                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase Authメール（`supabase/functions/send-auth-email`） | GoTrueが503 / 429で最大3回・総予算5秒で再試行 | **Resend idempotency key**。`webhook-id`（Standard Webhooks仕様でretry間も不変）から`auth/<webhook-id>/<action>/<recipient role>`を作る |
| Contact（Product / Web）                                    | ユーザーの再送信                              | Resend idempotency key。client生成の`submissionId`を使い、本文を編集したら新しいUUIDにする                                              |
| Welcome                                                     | サインイン経路の再実行                        | DB claim。`profiles.welcome_email_sent_at`の条件付きUPDATEで掴んでから送る                                                              |
| Stripe由来の課金メール                                      | Stripeのwebhook再送                           | DB claim。`stripe-webhook-idempotency.ts`                                                                                               |
| MFA disabled / account deletion                             | なし（server-side service の1回呼び出し）     | 何もしない                                                                                                                              |

**最後の行にkeyを足さない。** provider retryが走らないのでkeyが防ぐものが無い。パスワード変更通知は Auth Hook へ移し、`webhook-id` というイベント単位の安定IDで同一イベントの再試行だけを抑止する（#2848）。

パスワード変更通知も送信前に`email_suppressions`を確認する。suppressedまたは判定不能なら
Resendへ送らず、宛先を含まないSentry eventを残してAuth Hookへ200を返す。認証メールと同じ
From domainの評価を、既知のbounce / complaint先への再送で落とさないためである。

`webhook-id`が取れない時は**乱数へフォールバックしない**。毎回違うkeyはidempotencyとして無意味で、「冪等になったつもり」で`resolveSendAuthEmailStatus`の503→500降格を外すとかえって二重配送が増える。keyを作れない時はkey無しで送り、降格を従来どおり効かせる。

## 一時API keyの扱い

検証のために作った短命のResend API keyは、**検証が終わったら消すところまでが1つの作業**。

- 作成時に目的・scope（sending-only / domain限定）・ownerをIssueへ書く
- 値は1Passwordの正規itemへ入れない（長寿命keyと混ざるため）。検証中だけ手元に置く
- 削除前に、GitHub / Vercel / 1Password / Supabase / repo検索のすべてで参照0を確認する
- 削除は外部サービスの不可逆操作なので、確認結果を示してUserの承認を得てから実行する
- cleanupの証跡にkey値そのものを残さない

## 1. DNSと受信の準備（ユーザー作業）

1. Cloudflare Freeへ`dayopt.app`を追加する。nameserverはまだ変更しない
2. 自動取り込み後、現在のVercel DNSと照合する
   - apex `@` CNAME: `b50a3e55e0d68147.vercel-dns-017.com`
   - wildcard `*` CNAME: `cname.vercel-dns-017.com`
   - `send`のMX / SPF、`resend._domainkey`、`_dmarc.send`、CAA 3件を保持する
   - Vercel向けCNAMEは最初はすべてDNS onlyにする
3. Vercel Registrarの`Domains > dayopt.app > Nameservers > Edit`からCloudflare指定nameserverへ委譲する
4. CloudflareがActiveになったら`dayopt.app`、`www.dayopt.app`、`app.dayopt.app`、`mcp.dayopt.app`、`dayopt.app/docs`の到達性を確認する。`docs.dayopt.app`は使用しない
5. Cloudflare Email Routingをonboardし、Cloudflareが提示するroot MX / SPF / DKIMを適用する。`send`subdomainのResend recordと混同しない
6. 既存GmailをDestinationとして認証し、`support@dayopt.app`だけを転送する。catch-allは無効にする

DNS移管で到達性を失った場合は、Vercel Registrarのnameserverを元のVercel nameserverへ戻す。変更前のrecord一覧は値を秘密にする必要はないが、Cloudflare importとVercel表示を照合できる形で手元に保存する。

### DMARCはFrom domainの側に要る（2026-09-17 実測）

DMARCは**From headerのdomain**で評価される。Dayoptの実Fromは`noreply@dayopt.app` / `support@dayopt.app`のapexなので、参照されるのは`_dmarc.dayopt.app`であって`_dmarc.send.dayopt.app`ではない。

`dig +short TXT <name> @1.1.1.1` の実測:

| name                           | 実測値                                                  | 意味                                               |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| `_dmarc.dayopt.app`            | `cname.vercel-dns-017.com.`（wildcard `*` CNAMEが応答） | **DMARC TXTが無い。** 実Fromのdomainにpolicyが無い |
| `_dmarc.send.dayopt.app`       | `v=DMARC1; p=none; rua=mailto:dmarc@dayopt.app`         | From に使わない側にだけpolicyがある                |
| `send.dayopt.app` TXT          | `v=spf1 include:amazonses.com ~all`                     | Return-Path用SPF                                   |
| `resend._domainkey.dayopt.app` | DKIM公開鍵                                              | `d=dayopt.app`で署名される                         |

alignment自体は成立している（DKIMは`d=dayopt.app`でstrict alignment、SPFはReturn-Path `send.dayopt.app`とFrom `dayopt.app`が同じorganizational domainなのでrelaxed alignment）。欠けているのは**policyの公開だけ**で、apexへ1本足せば埋まる。

```
_dmarc.dayopt.app TXT "v=DMARC1; p=none; rua=mailto:dmarc@dayopt.app"
```

`p=none`は非強制なので既存配信を壊さない。apexにexplicit recordを置けばwildcard `*` CNAMEより優先される。強いpolicy（`p=quarantine` / `p=reject`）へ上げるのは、`rua`のレポートで全経路（Supabase Auth / Product・Web のResend / Gmail返信SMTP）のalignmentを確認してから。

## 2. 返信の準備（ユーザー作業）

1. Resendで`support-replies` API keyを作る
   - Sending access
   - `dayopt.app`domain限定
   - アプリ送信用keyと分離
   - 1Password `human/resend-support-replies`の`RESEND_SMTP_API_KEY`へ保存
2. Gmailの「アカウントとインポート > 他のメールアドレスとして送信」に`support@dayopt.app`を追加する
   - SMTP: `smtp.resend.com`
   - username: `resend`
   - password: 上記専用key
   - port: 465 / SSLまたは587 / TLS
   - 「メールを受信したアドレスから返信」を選ぶ
3. 別addressから`support@dayopt.app`へ送り、Gmailで受信して返信する
4. 相手側でFromが`support@dayopt.app`、個人Gmailが非表示、DKIMがpassすることを確認する

完了報告は「Cloudflare Active・受信成功・support@返信成功」の3点だけにする。nameserver、API key、個人addressは共有しない。

## 3. Merge前のProduction preflight

3点のユーザーcheckpoint後にIssue #1646の`status:blocked`を解除し、次を値を表示せず確認する。

既存1Password環境では`setup-1password.sh`を実行しない。このscriptは空のvault向け初回bootstrap専用なので、masterを次の順で手動更新する。

1. `human/resend-send`にapp配送用`RESEND_API_KEY` / `RESEND_FROM_EMAIL`があることを確認する（2026-09-14 に agent から移動）
2. `human/resend`のProduct用`RESEND_WEBHOOK_SECRET`を確認する
3. `human/resend-web`を作成し、Productと異なるWeb用`RESEND_WEBHOOK_SECRET`を保存する
4. 前節で作成した`human/resend-support-replies`を確認する
5. `pnpm 1password:check`を実行し、値ではなくitem / fieldの`OK`だけを確認する
6. master確認後にVercel / GitHubへ必要なreplicaを作る

- Product / Web Productionに`RESEND_API_KEY`、domain部分がapex `dayopt.app`と完全一致する`RESEND_FROM_EMAIL`、各app固有の`RESEND_WEBHOOK_SECRET`がある
- `send.dayopt.app`はSPF / Return-Path用のDNS subdomainであり、Fromには使用しない
- Product / Web ProductionにUpstash 2変数があり、Web ProductionにはTurnstile 2変数がある
- `RESEND_API_KEY`と`RESEND_WEBHOOK_SECRET`がPreview / Developmentをtargetにしない
- secretはVercelのSensitive typeを使う
- Product / Webのwebhook URLと署名secretがResend側で別々に設定されている
- 旧`GITHUB_TOKEN` / `GITHUB_CONTACT_REPO`がどのtargetにも存在しない

```bash
node scripts/ci/production-config-audit.mjs
```

このscriptはVercel API responseからkey / target / typeだけを取り出す。値の一致、sender domainの検証状態、Product / Web secretが異なることは証明できないため、Resend / Vercel dashboardで別途確認する。

`scripts/ci/production-config-audit.mjs`、両appの`production-build-gate.mjs`、audit workflow自体を変更するPRでは、base revisionのaudit結果をheadの証拠として扱わない。通常CIのsafe dummy testに加え、maintainerがexact head SHAのdiffをレビューしたclean checkoutでmetadata-only auditを実行し、その成功statusをhead SHAへ付ける。merge後のpushでも新contractが成功してからrequired statusを継続する。

## 4. DeployとProduction smoke

1. PRのrequired checkとPreviewを確認してmergeする
2. Product / Webが同じmerge SHAでReadyになるまで待つ。片方だけのReadyでsmokeを始めない
3. Productフォームから1通、Webフォームから1通だけ送る
4. 各送信で次を確認する
   - `support@dayopt.app`で1通だけ受信する
   - Reply-Toがフォーム送信者になる
   - Resend delivery sourceがProduct / Webで分離される
   - 対応する署名付きwebhookが2xxになり、retryで副作用が重複しない
   - logger / Sentryに問い合わせ本文、氏名、email、raw bodyがない
5. 30分観察し、新しい配送failure、rate-limit backend error、署名error、重複eventがないことを確認する

processed markerはPIIを含まないevent IDのHMACだけを35日間保持する。これはResendの自動retry期間と通常の30日以内のmanual replayを越える重複排除窓である。35日を過ぎたeventを再投入する場合は、既存Sentry eventを先に確認し、重複通知として扱う。

timeout後の再送やbounce / complaintを実在する第三者addressへ故意に発生させない。必要なfailure検証はunit testまたは所有するtest addressで行う。

## 5. Releaseと旧経路cleanup

観察完了後に次の順で行う。

1. `v0.32.1`tagと詳細なGitHub Releaseを作る
2. 両Vercel projectから旧`GITHUB_TOKEN` / `GITHUB_CONTACT_REPO`を削除して再deployする
3. 旧contact専用PATを失効する
4. metadata auditを実行し、旧2 envがどのtargetにも無いことを確認する
5. Issue #1646へPIIを含まない証跡を記録しcloseする
6. release branchと作業worktreeを削除する

`Dayopt/contact-private`は削除済みなので旧経路へのrollbackは行わない。application配送に問題がある場合はResend設定またはcodeを修正してroll-forwardする。

## 障害切り分け

| 症状                                     | 確認                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PreviewはReady、Production buildだけ失敗 | `Production Contract`の不足env名、Vercel Production target / typeを確認。Preview成功を根拠にしない                               |
| Production formが503                     | Upstash到達性、global / per-user・per-IP quota、Turnstileを確認。rate limitをfail-openにしない                                   |
| form成功だが受信しない                   | Resend delivery IDをprovider dashboardで確認し、root MXと`send`subdomain DNSを分けて確認する                                     |
| Resend APIがdomain authorizationの403    | API keyのdomain scopeとFromのdomain部分がともにapex `dayopt.app`か確認する。`send.dayopt.app`はReturn-Path用で、Fromには使わない |
| Gmailで受信しない                        | Cloudflare Email Routingのroute / Destination認証 / catch-all無効を確認する                                                      |
| 返信に個人Gmailが見える                  | Gmail Send mail asのFrom、Resend SMTP設定、「受信したアドレスから返信」を確認する                                                |
| webhookが401                             | app別endpointと署名secret、raw bodyが改変されていないことを確認する                                                              |
| webhookが503                             | Upstash lease backendを確認する。署名済みeventを未処理のまま200にしない                                                          |

## 関連

- [Contact仕様](../product/specs/contact.md)
- [Secrets](./secrets.md)
- [Environment Secrets](./security/environment-secrets.md)
- 旧 Project overview（`docs/projects/_archive/contact-delivery-migration/overview.md`、docs/projects 全廃に伴い #2473 で削除。git 履歴参照）
- Incident（削除済み、git 履歴参照）
