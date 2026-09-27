---
status: current
last_verified: 2026-09-22
---

# 入口の一覧（HTTP と cron）

外から product へ入ってくる HTTP の入口と、裏で勝手に動く定期実行（cron）を 1 か所で見る。**一覧は実装から機械が作る**（`apps/product/src/app/api/**/route.ts` と `apps/product/vercel.json` の `crons`）。説明（誰が・なぜ・止まると）だけを人が書く。route を足したのに説明が無い、route を消したのに説明が残っている、のどちらも `pnpm docs:check` が止める。

利用者の操作の大半は `/api/trpc` の 1 本を通る（[2 章](../02-ui-to-db.md)）。それ以外の入口は、外部サービスからの呼び出し（webhook・OAuth の戻り）、定期実行、監視、AI クライアント（MCP）のためにある。

<!-- learn:generated:start — 正本 apps/product/src/app/api の route.ts と vercel.json の crons（一覧）+ このファイルの learn:entrypoints の JSON（説明） / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->

行は実装から発見した入口（`route.ts` と `vercel.json` の `crons`）。説明は下の JSON。

| 入口                                                                                                                             | method           | 誰が呼ぶか                                                     | 間隔          | なぜあるか                                                                                                                                 | 止まると                                                                                                         | 経路                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`/api/cron/billing-reconciliation`](../../../apps/product/src/app/api/cron/billing-reconciliation/route.ts)                     | GET              | Vercel Cron                                                    | 毎日 2:15 UTC | Stripe の契約状態とアプリの記録を突き合わせる。**検出だけ**で、直さない                                                                    | 食い違いに気づくのが遅れる。webhook が正常なら食い違い自体は起きない                                             | [Pro を契約する（課金）](../journeys/billing.md) の 11                  |
| [`/api/cron/calendar-account-deletion-settle`](../../../apps/product/src/app/api/cron/calendar-account-deletion-settle/route.ts) | GET              | Vercel Cron                                                    | 毎時 5 分     | アカウント削除で残った外部連携の後始末（1 回 5 件まで、50 秒の予算）                                                                       | 削除自体は完了している。後始末が滞り、本番では最終完了から 180 分で異常として扱う                                | [アカウントを削除する（不可逆）](../journeys/account-deletion.md) の 11 |
| [`/api/cron/calendar-sync`](../../../apps/product/src/app/api/cron/calendar-sync/route.ts)                                       | GET              | Vercel Cron                                                    | 15 分ごと     | 取り込むカレンダーを選んだ接続の予定を、差分で取り込む。API は 15 秒で打ち切り、残りは次回                                                 | 外部の予定が古いまま。heartbeat が 15 分より古くなる。利用者の操作には影響しない                                 | [Google Calendar 連携](../journeys/google-calendar.md) の 9             |
| [`/api/cron/external-connection-maintenance`](../../../apps/product/src/app/api/cron/external-connection-maintenance/route.ts)   | GET              | Vercel Cron                                                    | 15 分ごと     | 切断した接続の token を Google 側で失効させる（revoke outbox）のと、security event の保持期限の掃除                                        | 失効が遅れる（token は保存の時点で消えているので、漏れはしない）。heartbeat で気づく                             | —                                                                       |
| [`/api/csp-report`](../../../apps/product/src/app/api/csp-report/route.ts)                                                       | HEAD POST        | ブラウザ（CSP 違反を検出した時に自動で）                       | —             | CSP 違反の報告を受けて Sentry に送る。ブラウザ拡張由来は捨て、rate limit で量を抑える                                                      | CSP 違反に気づけなくなるだけ。画面の動作には影響しない                                                           | —                                                                       |
| [`/api/health`](../../../apps/product/src/app/api/health/route.ts)                                                               | GET              | 外形監視（UptimeRobot）と、デプロイ後の確認                    | —             | DB（identity RPC → profiles）・Redis・env を短い timeout で確かめる。障害の切り分けの最初の 1 手                                           | 監視が鳴る。ただし Sentry はこの route の event を捨てるので、Sentry に無いのは正常                              | —                                                                       |
| [`/api/health/version`](../../../apps/product/src/app/api/health/version/route.ts)                                               | GET              | 開きっぱなしのタブ（フォーカスが戻った時）                     | —             | 配信中のビルドの版を返すだけ。自分より新しい deploy があればタブを自動で再読み込みする                                                     | 古いタブが自動で更新されなくなるだけ                                                                             | [merge → 本番公開](../journeys/deploy.md) の 7                          |
| [`/api/integrations/google-calendar/callback`](../../../apps/product/src/app/api/integrations/google-calendar/callback/route.ts) | GET              | ブラウザ（Google からの戻り）                                  | —             | code を token に交換して接続を保存する。state の不一致・scope 不足・write fence はここで弾く                                               | 同意しても接続が保存されず、設定画面へエラーで戻る                                                               | [Google Calendar 連携](../journeys/google-calendar.md) の 4             |
| [`/api/integrations/google-calendar/start`](../../../apps/product/src/app/api/integrations/google-calendar/start/route.ts)       | GET              | ブラウザ（設定画面の「接続」）                                 | —             | Google の同意画面へ送る。state と PKCE を cookie に封じ、Pro の利用権と rate limit を先に見る                                              | 新しい接続ができない。既存の接続の同期には影響しない                                                             | [Google Calendar 連携](../journeys/google-calendar.md) の 2             |
| [`/api/mcp`](../../../apps/product/src/app/api/mcp/route.ts)                                                                     | GET POST DELETE  | AI クライアント（Claude など。OAuth の bearer token 付き）     | —             | MCP の tool 呼び出しの入口。tRPC を通さず service role で DB 関数を呼ぶので、RLS が効かない側の入口                                        | AI クライアントからの読み書きだけが止まる。画面には影響しない                                                    | [AI クライアントから Plan を作る（MCP）](../journeys/mcp.md) の 6       |
| [`/api/oauth/token`](../../../apps/product/src/app/api/oauth/token/route.ts)                                                     | POST             | AI クライアント（authorization code / refresh token を持って） | —             | MCP 用の OAuth の token 発行（RFC 6749 §3.2）。PKCE 必須、client は静的な allowlist                                                        | MCP の新規接続と token の更新が止まる。既に持っている access token は期限まで使える                              | [AI クライアントから Plan を作る（MCP）](../journeys/mcp.md) の 4       |
| [`/api/trpc/[trpc]`](../../../apps/product/src/app/api/trpc/[trpc]/route.ts)                                                     | GET POST         | ブラウザ（product の画面）                                     | —             | 利用者の操作の API はすべてここを通る。IP 単位の rate limit → 認証 → MFA → 利用権 → write fence → 利用者単位の rate limit の順に関門を通す | 画面の操作が全部止まる。まず /api/health で DB と Redis を切り分ける                                             | [Plan を保存](../journeys/save-plan.md) の 5                            |
| [`/api/v1/calendar/[token]`](../../../apps/product/src/app/api/v1/calendar/[token]/route.ts)                                     | GET              | 外部のカレンダー（Google Calendar などが「URL で追加」で購読） | —             | 秘密 token 付き URL で、その利用者の Plan / Record を iCalendar 形式で返す。cookie も JWT も無いので token が鍵                            | 購読側のカレンダーが更新されなくなるだけ。token は設定画面で作り直せる                                           | —                                                                       |
| [`/api/v1/system/[...retired]`](../../../apps/product/src/app/api/v1/system/[...retired]/route.ts)                               | GET POST OPTIONS | 廃止した system API を今も呼んでいる古いクライアント           | —             | 常に 404 を返す。外部 I/O は無い。旧 API の URL を静かに死なせるための置き場                                                               | 無い（何もしない入口）                                                                                           | —                                                                       |
| [`/api/webhooks/resend`](../../../apps/product/src/app/api/webhooks/resend/route.ts)                                             | POST             | Resend（署名付き POST）                                        | —             | メールの配信結果（bounce・complaint）を受けて、送信停止リストを更新する。Redis の lease で二重処理を防ぐ                                   | bounce した宛先へ送り続ける。送信自体は止まらない                                                                | [サインアップ → ウェルカムメール](../journeys/signup.md) の 7           |
| [`/api/webhooks/stripe`](../../../apps/product/src/app/api/webhooks/stripe/route.ts)                                             | POST             | Stripe（署名付き POST）                                        | —             | 契約状態を変えてよい唯一の入口。署名 → identity → 冪等 claim を通して subscription を同期する                                              | 決済は Stripe 側で成立するのに、アプリの契約状態が更新されない。Stripe Dashboard の配信履歴と runbook Playbook 3 | [Pro を契約する（課金）](../journeys/billing.md) の 5                   |

<!-- learn:generated:end -->

## cron に共通すること

- 呼ぶのは Vercel Cron。`Authorization: Bearer <CRON_SECRET>` が合わないと 401 で何もしない
- **取りこぼした回を埋め直さない**。止まったことは、完了記録（heartbeat）が古くなることで気づく（[7 章](../07-failures.md)）
- write fence が ON の間は 503 で何もしない（[7 章](../07-failures.md) の write fence）
- 時間の予算を持ち、超えたら途中でやめて次回に回す

## 関連

- [外部サービスと停止マップ](services.md) — 入口の先で使うサービスが止まった時
- [7. 障害](../07-failures.md) — 入口ごとの痕跡の残り方
- [10. API / MCP](../10-api-mcp.md) — `/api/mcp`・`/api/oauth/token`・`/api/v1`
- [docs/engineering/architecture.md](../../engineering/architecture.md) — REST の allowlist（新規 API は tRPC）

## 正本（説明）

```json learn:entrypoints
{
  "title": "入口の一覧",
  "intro": "行は実装から発見した入口（`route.ts` と `vercel.json` の `crons`）。説明は下の JSON。",
  "notes": {
    "/api/trpc/[trpc]": {
      "who": "ブラウザ（product の画面）",
      "why": "利用者の操作の API はすべてここを通る。IP 単位の rate limit → 認証 → MFA → 利用権 → write fence → 利用者単位の rate limit の順に関門を通す",
      "outage": "画面の操作が全部止まる。まず /api/health で DB と Redis を切り分ける",
      "journey": { "id": "save-plan", "hop": "route" }
    },
    "/api/mcp": {
      "who": "AI クライアント（Claude など。OAuth の bearer token 付き）",
      "why": "MCP の tool 呼び出しの入口。tRPC を通さず service role で DB 関数を呼ぶので、RLS が効かない側の入口",
      "outage": "AI クライアントからの読み書きだけが止まる。画面には影響しない",
      "journey": { "id": "mcp", "hop": "mcp-route" }
    },
    "/api/oauth/token": {
      "who": "AI クライアント（authorization code / refresh token を持って）",
      "why": "MCP 用の OAuth の token 発行（RFC 6749 §3.2）。PKCE 必須、client は静的な allowlist",
      "outage": "MCP の新規接続と token の更新が止まる。既に持っている access token は期限まで使える",
      "journey": { "id": "mcp", "hop": "token" }
    },
    "/api/webhooks/stripe": {
      "who": "Stripe（署名付き POST）",
      "why": "契約状態を変えてよい唯一の入口。署名 → identity → 冪等 claim を通して subscription を同期する",
      "outage": "決済は Stripe 側で成立するのに、アプリの契約状態が更新されない。Stripe Dashboard の配信履歴と runbook Playbook 3",
      "journey": { "id": "billing", "hop": "webhook-verify" }
    },
    "/api/webhooks/resend": {
      "who": "Resend（署名付き POST）",
      "why": "メールの配信結果（bounce・complaint）を受けて、送信停止リストを更新する。Redis の lease で二重処理を防ぐ",
      "outage": "bounce した宛先へ送り続ける。送信自体は止まらない",
      "journey": { "id": "signup", "hop": "resend-webhook" }
    },
    "/api/integrations/google-calendar/start": {
      "who": "ブラウザ（設定画面の「接続」）",
      "why": "Google の同意画面へ送る。state と PKCE を cookie に封じ、Pro の利用権と rate limit を先に見る",
      "outage": "新しい接続ができない。既存の接続の同期には影響しない",
      "journey": { "id": "google-calendar", "hop": "start" }
    },
    "/api/integrations/google-calendar/callback": {
      "who": "ブラウザ（Google からの戻り）",
      "why": "code を token に交換して接続を保存する。state の不一致・scope 不足・write fence はここで弾く",
      "outage": "同意しても接続が保存されず、設定画面へエラーで戻る",
      "journey": { "id": "google-calendar", "hop": "callback" }
    },
    "/api/cron/calendar-sync": {
      "who": "Vercel Cron",
      "why": "取り込むカレンダーを選んだ接続の予定を、差分で取り込む。API は 15 秒で打ち切り、残りは次回",
      "outage": "外部の予定が古いまま。heartbeat が 15 分より古くなる。利用者の操作には影響しない",
      "journey": { "id": "google-calendar", "hop": "cron-sync" }
    },
    "/api/cron/external-connection-maintenance": {
      "who": "Vercel Cron",
      "why": "切断した接続の token を Google 側で失効させる（revoke outbox）のと、security event の保持期限の掃除",
      "outage": "失効が遅れる（token は保存の時点で消えているので、漏れはしない）。heartbeat で気づく",
      "refs": [
        {
          "path": "apps/product/src/app/api/cron/external-connection-maintenance/route.ts",
          "find": "Calendar revoke outbox と payload-free security event retention の集約 cron"
        }
      ]
    },
    "/api/cron/calendar-account-deletion-settle": {
      "who": "Vercel Cron",
      "why": "アカウント削除で残った外部連携の後始末（1 回 5 件まで、50 秒の予算）",
      "outage": "削除自体は完了している。後始末が滞り、本番では最終完了から 180 分で異常として扱う",
      "journey": { "id": "account-deletion", "hop": "settle-cron" }
    },
    "/api/cron/billing-reconciliation": {
      "who": "Vercel Cron",
      "why": "Stripe の契約状態とアプリの記録を突き合わせる。**検出だけ**で、直さない",
      "outage": "食い違いに気づくのが遅れる。webhook が正常なら食い違い自体は起きない",
      "journey": { "id": "billing", "hop": "reconcile" }
    },
    "/api/v1/calendar/[token]": {
      "who": "外部のカレンダー（Google Calendar などが「URL で追加」で購読）",
      "why": "秘密 token 付き URL で、その利用者の Plan / Record を iCalendar 形式で返す。cookie も JWT も無いので token が鍵",
      "outage": "購読側のカレンダーが更新されなくなるだけ。token は設定画面で作り直せる",
      "refs": [
        {
          "path": "apps/product/src/app/api/v1/calendar/[token]/route.ts",
          "find": "秘密トークンURLでユーザーのタイムブロックをiCalendar形式で返却"
        }
      ]
    },
    "/api/v1/system/[...retired]": {
      "who": "廃止した system API を今も呼んでいる古いクライアント",
      "why": "常に 404 を返す。外部 I/O は無い。旧 API の URL を静かに死なせるための置き場",
      "outage": "無い（何もしない入口）"
    },
    "/api/health": {
      "who": "外形監視（UptimeRobot）と、デプロイ後の確認",
      "why": "DB（identity RPC → profiles）・Redis・env を短い timeout で確かめる。障害の切り分けの最初の 1 手",
      "outage": "監視が鳴る。ただし Sentry はこの route の event を捨てるので、Sentry に無いのは正常",
      "refs": [
        {
          "path": "apps/product/src/app/api/health/route.ts",
          "find": "外形監視の信号を「timeout」に化けさせないため短めに抑える"
        }
      ]
    },
    "/api/health/version": {
      "who": "開きっぱなしのタブ（フォーカスが戻った時）",
      "why": "配信中のビルドの版を返すだけ。自分より新しい deploy があればタブを自動で再読み込みする",
      "outage": "古いタブが自動で更新されなくなるだけ",
      "journey": { "id": "deploy", "hop": "tab-update" }
    },
    "/api/csp-report": {
      "who": "ブラウザ（CSP 違反を検出した時に自動で）",
      "why": "CSP 違反の報告を受けて Sentry に送る。ブラウザ拡張由来は捨て、rate limit で量を抑える",
      "outage": "CSP 違反に気づけなくなるだけ。画面の動作には影響しない",
      "refs": [
        {
          "path": "apps/product/src/app/api/csp-report/route.ts",
          "find": "ブラウザ拡張機能由来のCSP違反はSentryに送信しない"
        }
      ]
    }
  }
}
```
