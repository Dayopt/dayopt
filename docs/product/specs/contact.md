---
status: current
last_verified: 2026-07-24
code:
  - apps/product/src/features/contact
  - apps/web/src/app/api/contact
# 問い合わせ導線は /contact ページ自体が入口で、公開docsのページは持たない
public_docs: []
lp: []
---

# Contact（問い合わせ・フィードバック）

ProductとWebから受け付けた問い合わせを、Production限定で`support@dayopt.app`の運用受信箱へ配送する。

## 現在の振る舞い

- Productは認証済みユーザー向け`contact.submit`、Webは公開`POST /api/contact`で問い合わせを受け付ける
- 両interfaceは`submissionId: uuid`を必須とし、成功時は`{ success: true }`を返す
- 配送先は固定の`support@dayopt.app`。From、件名、source tagはserverが固定し、検証済みの送信者emailだけをReply-Toに使う
- 配送はResend APIを使い、10秒でtimeoutする。同じclient contact intentの再送は同じ`submissionId`とidempotency keyを使い、フォーム内容を編集した後は新しいIDを使う。Productの氏名・emailは配送時に認証済みprofileから取得するmetadataであり、intent IDには含めない
- 配送に失敗した場合は成功表示にせず入力を保持する。WebはTurnstile tokenだけを破棄し、再検証する
- credentialが存在してもProduction以外では配送しない。Preview / Developmentは実受信箱へ書き込まない
- Productはuser単位と全体、WebはIP単位と全体のrate limitをUpstashで適用する。Productionでbackendを利用できない時は配送せずfail-closedにする
- WebはCSRF、JSON content type、16 KiB body上限、strict schema、honeypot、Turnstile action / Production hostnameを検証する
- Product / Webは別々の`POST /api/webhooks/resend`と署名secretを使う。source tagと固定Toで所有eventを判定し、processing leaseとprocessed markerでretryを重複排除する
- 配送failureは問い合わせ本文・氏名・email・raw webhook bodyを含めずにSentryへ記録する。HTTP responseとloggerにも問い合わせPIIを含めない
- 問い合わせ原文はResendの配送処理とアクセス制限付きGmailで扱う。開発対応が必要な内容だけPIIを除いて通常Issueへ転記し、ユーザーの声はCLAUDE.mdに従って日付付きfeedback logへ記録する

## 入力

| 項目           | Product                                      | Web                               |
| -------------- | -------------------------------------------- | --------------------------------- |
| `submissionId` | UUID                                         | UUID                              |
| `category`     | `bug / feature / question / other`           | 同左                              |
| `message`      | 10〜5000文字                                 | 10〜1000文字                      |
| name / email   | 認証済みuserからserverで取得                 | form入力をtrim・検証              |
| environment    | app version、OS、browser、timezone、language | なし                              |
| bot対策        | 認証 + rate limit                            | honeypot + Turnstile + rate limit |

## 運用前提

- Product / WebのVercel ProductionだけにResend、Upstash、必要なTurnstile envを置く
- Product / WebのResend webhook secretは別値にする
- `support@dayopt.app`の受信はCloudflare Email Routingから既存Gmailへ転送し、返信は専用Resend SMTP keyを使う
- 保存、削除、rotation、Production smokeは[問い合わせメール運用](../../operations/contact-email.md)に従う
- Cloudflare Active・受信成功・support@返信成功を確認するまでIssue #1646をunblockせず、Productionへ切り替えない

## 関連する意思決定

- 問い合わせの受信と送信をCloudflare・Gmail・Resendへ分離する（削除済み、git 履歴参照）
