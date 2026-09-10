---
status: current
last_verified: 2026-08-25
code:
  - packages/observability
  - apps/product/src/instrumentation.ts
  - apps/product/instrumentation-client.ts
  - apps/web/src/instrumentation.ts
  - apps/web/instrumentation-client.ts
  - apps/product/src/app/api/health/route.ts
---

# 監視・アラート

Dayoptのproduction監視はSentry、Vercel、Supabase、`/api/health`、UptimeRobotを組み合わせる。障害発生後の対応は[runbook](./runbook.md)、error capture実装規約は[error-handling skill](../../.agents/skills/error-handling/SKILL.md)を参照する。

## Monitoring surfaces

| Surface                     | 見るもの                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 正本                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Sentry                      | unexpected error、正規化済みCSP violation、performance trace                                                                                                                                                                                                                                                                                                                                                                                                                           | Sentry dashboard + Product / Web の runtime config                                                                           |
| Vercel                      | deployment、function error / duration、traffic、build failure                                                                                                                                                                                                                                                                                                                                                                                                                          | Vercel dashboard                                                                                                             |
| Supabase                    | database health、connection、API error、storage、Auth                                                                                                                                                                                                                                                                                                                                                                                                                                  | Supabase dashboard                                                                                                           |
| Health endpoint             | app、database、必要な環境設定の疎通                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `GET /api/health`                                                                                                            |
| UptimeRobot                 | 外形監視（`/api/health` のHTTP status、5分間隔）、uptime、incident、response time                                                                                                                                                                                                                                                                                                                                                                                                      | UptimeRobot dashboard + メール通知。AI調査経路は[mcp-usage](../../`mcp-usage` skill)のUptimeRobot節（read-onlyオンデマンド） |
| GitHub Actions              | type / lint / test / build / secret scan / docs 整合性チェック（`ci.yml` の impact →（static ∥ unit ∥ integration）job に統合済み、#2483 / #2539）。**失敗の自動起票**: `promote.yml`（Production Release）、`production-config-audit.yml`（deploy-health、Supabase Auth / Storage RLS audit）、`nightly.yml`（R2 storage backup / replica-check / label sweep）はいずれも title-prefix 方式で `[auto] ...` issue を 1 本立てて追記する。**自動で閉じないので直したら手で close する** | `.github/workflows/`                                                                                                         |
| Axiom（未実施）             | Vercel Log Drains 経由の runtime / build / static log（契約表に載らない経路も含む全量）                                                                                                                                                                                                                                                                                                                                                                                                | Axiom dashboard（`vercel` dataset）。導入手順は下記 §Log Drains（Axiom）（未実施）                                           |
| Supabase Edge Function logs | `send-auth-email` の `send failed` / `capture failed`（Sentry envelope の送信自体が失敗した場合。#2682）                                                                                                                                                                                                                                                                                                                                                                               | Supabase Dashboard → Edge Functions → Logs                                                                                   |

provider plan、sampling rate、SDK versionなどの値は変わるため、package manifest・runtime config・dashboardを正とする。

## Sentry runtime contract

- Product と Web は別 Sentry project とし、quota、alert、release、DSN を分離する
- server / edge は Production だけで常時初期化する。browser SDK、Analytics、Speed Insights は analytics consent 後だけ初期化する
- **認証未完了フロー（`/auth/*`）は client telemetry の対象外**。同意バナーは LCP 最適化のため `/auth/*` では表示されず（認証後に表示）、その配下では分析同意を得る機会が一度も無い。つまり signup / login 失敗など認証未完了中に起きたエラーは browser Sentry に届かない（#2029）。この窓の一次証跡は Supabase Auth logs（dashboard）を見る。privacy 境界（analytics 同意後だけ browser telemetry を有効化する）を崩してまでこの窓を埋めることはしない — 2026-07-16 の frozen 決定（決定ログ（削除済み、git 履歴参照））を優先する
- browser telemetryの同意撤回時はclientを即時無効化してページを再読込し、SDK integration、active span、breadcrumb scopeを残さない
- Session Replayは、現行SDKではRRWeb metadataとReplay envelopeのraw URL queryを通常sanitizerで除去できないため無効にする
- build integration と source map upload は Vercel Production build だけで実行する。CI / Preview / Development に `SENTRY_AUTH_TOKEN` を置かない
- 両 Vercel project は同じ env 名を使うが、DSN と project 値は project scope ごとに異なる。env の正本は [secrets](./secrets.md)
- sanitizer と同意判定は `packages/observability`、app 固有の初期化は各 app の instrumentation / Sentry config を正とする
- user context は内部 ID だけを使う。email、user content、request body、request header、cookie、authorization、URL query は送信しない
- `event_id`、`trace_id`、`span_id`、release、environment など Sentry protocol 値は変更しない

主なcapture経路:

- React / App Router error boundary
- tRPCのunexpected internal error
- `/api/csp-report`の有効なCSP violation
- Stripe webhook等のroute handlerで捕捉したunexpected error
- loggerのerror / warn breadcrumb
- `send-auth-email`（Supabase Edge Function、DSN 未投入なら no-op）: render / Resend 送信失敗（HTTP 500 / 503）。tags は `action` / `phase` / `kind` / `status` / `resend_error`、extra は `subject` / `firstEmailAlreadySent`。宛先 email・本文・token_hash は送らない。署名不一致（HTTP 401）は攻撃者由来のノイズを Issues に入れないため capture しない。DSN は Supabase secret `SENTRY_DSN`（[secrets](./secrets.md)）。**status の意味**: Auth Hook は 503 / 429 を retryable として扱い、5 秒の総予算内で最大 3 回まで同じ hook を呼び直す（2026-09-10 実測）。そのため Resend の availability 失敗だけを 503 にし、`email_change` の 2 通目失敗のように**すでに 1 通送信済み**の状態では 500 へ落とす（再試行すると 1 通目が重複配送されるため）。capture 自体は 1 秒で打ち切り、観測のために hook を timeout させない

expected auth / validation / not-found / conflict、Web Vitals、正常な login / billing event は Issues に送らない。性能は trace と Speed Insights、正常系行動は既存 analytics で確認する。

新しい`try/catch`やSentry captureを追加する場合は`.agents/skills/error-handling/SKILL.md`を先に読む。

### Provider-side status (2026-07-23)

- Product project `dayopt` と Web project `dayopt-web` を分離済み。両projectでIP addressを保存せず、default scrub / server-side scrub / custom sensitive fieldsをorganization設定から継承する
- 両projectでSpike Protectionを有効化し、`ChunkLoadError`は一律filterしない。browser key loaderのSession Replayも無効化している
- Productの既存高優先度alertを維持し、Webに同等の高優先度alertを作成した。Webのtest notificationが実メールへ届くことまで確認済み
- organizationはowner 1名で、2FA必須化とjoin request停止を適用済み。open team membership、memberによる招待・project作成・event削除・monitor/alert編集はすべて無効化している
- Sentry build tokenはVercel作成のinternal integrationを使い、Issue/Event accessを付与しない。release/source map以外へ用途を広げない

運用リンク:

- [Product health dashboard](https://dayopt.sentry.io/dashboard/8390965/?environment=production&project=4509737836412928)
- [Web health dashboard](https://dayopt.sentry.io/dashboard/8390994/?environment=production&project=4511741979394048)
- [Organization Stats](https://dayopt.sentry.io/stats/) — accepted / discarded / filtered / quotaはcustom dashboard datasetで表現できないため、このbuilt-in画面を正とする

各health dashboardはunresolved Issue、release別error、transaction failure rate、transaction duration p50/p75/p95、Replay-linked error件数（期待値0）を表示する。provider設定の変更履歴とProduction smokeのevent-level証跡は[#1566](https://github.com/Dayopt/dayopt/issues/1566)に集約する。

Product / Webのbrowserを含むProduction検証、alert email、source map、trace、PII境界のevent-level証跡は[#1566](https://github.com/Dayopt/dayopt/issues/1566)を正とする。Product Edgeの元TypeScript行へのsymbolicationだけはVercel Edge再bundleのupstream制約があり、release・trace・PII不在を受入条件とする。

### Production検証用surfaceの撤去契約

2026-07-23の検証に使ったoperator専用surfaceは恒久APIや一般ユーザー向けUIにせず、active sourceから撤去した。将来再検証が必要な場合も既存surfaceを復元して常設せず、次の契約を満たす短命変更を別途reviewする。

- raw tokenをconsole、clipboard、DOM、URL、cookie、storage、docs、issueへ残さず、providerにはapp別digestだけを置く
- Production限定flag、固定deadline、env expiry、same-origin、空body、IP/global rate limitでfail closedにする
- 検証traceだけを一時的に100% sampleし、通常のProduct/Web browser・server 10%と両Edge 5% samplingは変えない
- 対象project、deployment URL、commit SHA、event、alert、削除手順を[#1566](https://github.com/Dayopt/dayopt/issues/1566)相当の運用issueへ記録する
- flag-off deployの後にcodeと一時envを削除し、canonical URLと記録済み旧deployment URLのGET / POST / OPTIONSが404であることを確認する

## Log Drains（Axiom）（未実施）

策定日: 2026-08-14（#1701 Phase 3 の残作業）。**内製クロスレビュー（2026-08-14）で P1 指摘 2 件を受け、Drain 作成の前提条件を legal 判断とデータ内容確定の 2 段に分離した。**

**目的**: 個別 route の契約表（本ファイル §Monitoring surfaces、`infra.md` §API Endpoints）に載らない経路（Server Action、ISR 再生成、Middleware、ビルドログ）を含む runtime / build ログの全量を、Vercel dashboard の保持期間を超えて横断検索できるようにする。ベンダーは Axiom に確定済み（保存リージョンの固定要件なし、CHECKPOINT で User 承認。決定の経緯は #1701 のコメント参照）。

**権限境界**: 本節は手順書であり、**Drain 作成の実操作、サブプロセッサー追加の意思決定、送信フィールドの確定は User が行う（`EXPLICIT AUTHORITY`）**。repo 側のコード変更は無い（Vercel Marketplace 経由の team-level 設定のみ）。

### 前提: コストと課金体系（確認日 2026-08-14 時点）

- Vercel の Log Drains は **Pro / Enterprise plan 限定**（Dayopt は Pro plan で対象）
- 課金は **転送量 $0.50/GB、無料枠なし**。計測は圧縮前の JSON serialize サイズで、Axiom 側の "bytes received" 表示より大きく出るのが仕様（Vercel 公式ドキュメント）
- Axiom 公式ドキュメントは、高 volume な場合は Drains 経由の Marketplace 連携より `next-axiom` ライブラリ（アプリ内 SDK 直接送信）の方が安いと明記している。Dayopt は Drains（Marketplace 連携）を選んだ — 契約表に載らない経路まで無条件に拾える運用の単純さを優先した判断で、`next-axiom` への切替は volume が実際に膨らんでから再検討する（出口コスト: Drain を切って `next-axiom` の instrumentation を各 app に追加するだけなので `[hours]`）
- 上記の単価・plan 条件は Vercel 側の変更可能性があるため、実施直前に再確認する

### 手順

1. **legal 前提（Drain 作成より先に完了させる）** — Axiom は Dayopt の privacy policy が個別列挙するサブプロセッサーに該当しうる新規追加で、privacy.mdx は「導入の少なくとも 30 日前に通知」を約束している。手順どおり Drain を作るだけでは、この約束を素通りして公開ポリシー違反になる
   - **完了（2026-08-17、#1701 コメント参照）**: `apps/web/content/legal/{ja,en}/privacy.mdx` の subProcessors 節へ Axiom を追記済み。決定の記録は 決定ログ（削除済み、git 履歴参照）
   - **30 日時計の起点はこの追記が production へ公開された日**（merge 日ではなく deploy 日）。Drain 作成はその 30 日後以降に行う。公開日は該当 PR の merge 後、Vercel Production deployment のタイムスタンプで確認する
   - この judgment（サブプロセッサーを追加するかどうか）自体が `EXPLICIT AUTHORITY` で、User 承認済み（#1701 コメント）
2. **Drain が送信するフィールドの確定（legal 前提と並行して検討可、Drain 作成より先に確定させる）** — Log Drain はアプリの構造化ログだけでなく **Vercel 自身の request log**（path / query / clientIp / userAgent 等）を運ぶ。既存の `@/lib/logger` sanitize 方針（本ファイル §Sentry runtime contract）はアプリコードが出す構造化ログにしか及ばず、Vercel の request log には適用されない
   - **具体的な露出**: (a) iCal feed の URL（`/api/v1/calendar/{token}.ics`）は token が URL path に入る長期 bearer credential で、request log に path が含まれる設定だと Drain 経由で Axiom に恒久記録される（= feed 利用者のカレンダー閲覧権が第三者 store に写る） (b) OAuth callback の `code` / `state` が query に入る
   - **確定（2026-08-17、#1701 コメント参照）**: request log の path / query は Drain 対象から除外する。iCal feed token・OAuth code/state の Axiom への恒久記録を構造的に避けるための判断で、デバッグ用途は Sentry + アプリ構造化ログでカバーする。不足が実測されたら除外の緩和を別途判断する
   - **上記の除外設定を Drain 作成時（下記手順 4）に反映する**
3. **Spend Management の上限設定** — 無料枠なしの従量課金への対策。Vercel team dashboard → **Settings → Billing → Spend Management** を有効化し、USD 上限額を設定する。Owner または Billing role が必要
   - **上限額の設定は通知のみで、支出を自動的に止めない。** 「production を自動一時停止」オプションを別途有効化しない限り、上限到達後もログ転送と課金は継続する。本番影響が大きいため既定では自動一時停止を有効化せず、通知（50% / 75% / 100%、**Settings → My Notifications** で Web / Email、必要なら SMS を有効化）を受けた人間が手動で対応する運用とする
   - 閾値通知を受けた時の一次対応は下記 rollback（Drain disable）を参照。solo 運用のため対応までの遅延は保証されない — 上限額は「気づかず膨らむ額」の許容上限として、実コストより余裕を持たせて設定する
4. **Axiom Marketplace integration の接続** — [Vercel Integrations: Axiom](https://vercel.com/integrations/axiom) から Install し、Dayopt team とリンクする。接続対象 project は `product` / `web` を選択する。Drain 作成時に手順 2 で確定したフィールド設定を反映する
   - この操作で Axiom 側に Log Drain が自動作成され、ログは Axiom の `vercel` dataset へ即座に流れ始める（Axiom 側での事前の dataset 作成や API token 発行は不要 — integration が自己完結する）
5. **検証** —
   - Vercel team dashboard → **Settings → Drains** で、作成された Drain の status が `enabled` であることを確認する
   - Axiom dashboard → `vercel` dataset で、直近デプロイのログが実際に届いていることを確認する（`vercelProjectName` フィールドで product / web を区別できる）。手順 2 で除外を決めたフィールド（iCal token 等）が実際に含まれていないことも合わせて確認する
   - Spend Management の **Activity** セクション（team dashboard サイドバー）で、上限設定が反映されていることを確認する
   - Axiom は dataset 作成時にリージョンを US East / EU Central の 2 択で選ぶ。privacy.mdx の Axiom サブプロセッサー記載（Data location: United States）を真に保つため、dataset のリージョンが **US East** であることを Axiom dashboard の dataset 設定で確認する
6. **rollback**（`[hours]`） — Vercel team dashboard → Settings → Drains から該当 Drain を disable、または Integrations 画面から Axiom を uninstall する。課金は停止時点までの転送量分のみ

### 運用上の注意

- Drain は team scope の設定であり、コードや env に新しい secret は増えない（`docs/operations/secrets.md` の対象外）
- **既存の `@/lib/logger` 構造化ログの sanitize 方針は、アプリコードが出すログにのみ適用される。** Vercel の request log（path / query / clientIp / userAgent）は別経路で Drain に乗るため、上記手順 2 で送信フィールドを確定するまでは「sanitize 方針に従っているから安全」と読まない

## Supabase `log_connections`

策定日: 2026-08-25（[#1597](https://github.com/Dayopt/dayopt/issues/1597)）

Supabase は新規 project の `log_connections` を既定 off へ移行しており、既存 project も順次移行対象になる。Dayopt Production は現在 **off**（2026-08-02 / 2026-08-25 の 2 回、SQL editor で `SHOW log_connections;` を実行して確認）。

- **既定は off のまま運用する**。接続プール枯渇・不審接続の調査などログの価値がログ量・料金を上回る場合だけ、一時的に on へ切り替える
- **有効化手順**: Supabase dashboard の SQL editor で `ALTER SYSTEM SET log_connections = on; SELECT pg_reload_conf();` を実行する。調査終了後は同じ手順で `off` に戻す。runtime config の変更であり、`supabase/migrations/` には残さない
- **Preview（PR ごとの branch）は対象外**。non-persistent（`with_data: false`）かつ既定 off の新規 project 相当のため、常設の確認対象にならない

### Logs ingestion / query の課金は 2026-08-25 時点で未稼働

Supabase 公式ドキュメント（[Manage Logs usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs)）は "Coming soon" 表記で、Logs Ingest / Logs Query の課金・quota は enforcement 未稼働。Dayopt org の Usage ページ（Supabase dashboard → Settings → Billing → Usage）にも "Logs Ingest" / "Logs Query" の行がまだ現れない（2026-08-25 確認、Egress / Compute Hours 等の既存 SKU のみ表示）。

- 「Ingest 月5GB / Query 月1,000GB」は Supabase 側のドキュメントにまだ反映されていない暫定値のため、現時点でこの枠に対する具体的な進捗率は確認できない
- **enforcement が有効化されたら**、下記 §Scheduled review の月次棚卸しで Usage ページを確認し、実際に公表された quota の 80% 到達を確認・対応の目安にする（他の枠で使っている閾値慣行に合わせた既定値。実 quota 公表後に必要なら調整する）

## Alert policy

### Immediate

- productionのunhandled errorが新規発生または急増
- `/api/health`が503を返す
- login、Calendar data load、Plan / Record write、Stripe webhook等のcritical pathが継続失敗
- production deployment失敗

### Scheduled review

- error volume / regression: 週次
- Vercel function duration、bandwidth、build trend: 週次
- Supabase database size、connection、slow query: 週次
- provider usage / plan limit: 月次（Supabase Logs ingest/query の quota 確認基準は §Supabase `log_connections` 参照。enforcement 稼働後に対象化）
- **`send-auth-email` の error 件数: 月次**（#2682）。Sentry で `tags[function]:send-auth-email` を検索し、件数が 0 であることを確認する。0 件でなければ Resend availability（503）か render / Resend 拒否（500）が起きている。署名不一致（401）はここに含まれない（capture 対象外のため）
- **browser client telemetry の生死確認: 月次**（#2029）。Sentry で `environment:production has:browser.name` を直近30日で検索し、件数が0でないことを確認する。0件なら consent gate・DSN・CSP・SDK 初期化のどこかが壊れている可能性が高く、決定ログ（削除済み、git 履歴参照） の contract に沿って client 側の初期化パス（`instrumentation-client.ts` / `packages/observability/src/consent.ts`）を調査する。新しい常設 canary surface は作らない（2026-07-16〜23 に一時追加した operator smoke surface は複雑さに見合わず撤去済み）
- **体感速度北極星（production LCP p95 / INP p95）の月次確認: 月次**（#2294）。product（Sentry project `dayopt`）の Web Vitals を [LCP saved query](https://dayopt.sentry.io/explore/traces/?query=has%3Ameasurements.lcp+environment%3Aproduction&project=4509737836412928&aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%2C%22p75%28measurements.lcp%29%22%2C%22p95%28measurements.lcp%29%22%5D%7D&mode=aggregate&sort=-count%28%29&statsPeriod=30d&table=span) / [INP saved query](https://dayopt.sentry.io/explore/traces/?query=has%3Ameasurements.inp&project=4509737836412928&aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%2C%22p75%28measurements.inp%29%22%2C%22p95%28measurements.inp%29%22%5D%7D&mode=aggregate&sort=-count%28%29&statsPeriod=30d&table=span) で開き、p95 と n（count）を確認する。budget は `docs/engineering/infra.md` §速度指標（LCP p95≤2.5s、INP p95≤200ms）。2026-08-24 baseline: LCP p75=1318ms/p95=2101.2ms（n=110）、INP p75=96ms/p95=103.84ms（n=104）、いずれも budget 内。**INP query はあえて `environment:production` を付けない** — INP は Sentry SDK の仕様で standalone span に `environment` タグが付かないため（`environment:production` で絞ると誤って count=0 になる）。product は `enabled: IS_SENTRY_PRODUCTION`（`apps/product/instrumentation-client.ts:66`）で `Sentry.init` の `enabled` オプション自体を production 限定にし、web は `isProduction` 定数（`apps/web/instrumentation-client.ts:24`）で `initializeBrowserSentry()`（`Sentry.init` 呼び出し自体）を production 以外で実行しない lazy init gate にしている（web 側の `Sentry.init` の `enabled` は `true` 固定）。実装形は異なるが、両者とも production 以外で SDK 自体を init しない構造的 gate という不変条件は同じため、フィルタなしでも値は production 限定と確定できる。**n を必ず確認する** — p95 は少数サンプルで暴れるため、n が前月比で大きく変動した月（consent UI 変更、計測ソース変更、トラフィック構成変化など）は単純比較せず断点として本節にコメントで残す。閾値アラートは n がまだ小さく統計的に成立しないため作らない（この月次確認と `docs/engineering/infra.md` §行動ルール の「p95悪化 → 改善Issue必須」で代替する）。時系列比較が要る時は saved query の期間を切って再取得する（journal は持たない。2026-09-02、gardening 統合）

通知channelはprovider dashboardとemailを基本とする。

## Incident triage

1. alertのenvironment、release、first seen、affected user数を確認する
2. Vercel deployment / function logとSentry traceを同じ時刻で照合する
3. DB/Authが関係する場合だけSupabase dashboardを確認する
4. user impactがある場合はGitHub issueとして起票する（2026-08-28、#2475でdomain log/廃止に伴い移行）
5. 復旧手順の変更はissueではなくrunbookへ反映する

secret、request body、user contentをissue・docs・chatへ貼らない。

## Verification

```bash
pnpm --filter @dayopt/observability exec vitest run src/sanitize.test.ts
pnpm --filter @dayopt/product exec vitest --project unit run src/lib/sentry/__tests__/scrub-pii.test.ts
pnpm --filter @dayopt/web exec vitest run src/app/api/csp-report/route.test.ts src/platform/observability/instrumentation-client.test.ts
pnpm typecheck
pnpm lint
pnpm lint:boundaries
pnpm docs:check
```

production dashboardへのtest event送信やalert設定変更は、目的と対象environmentを確認して明示承認を得てから行う。repositoryには常設のtest surfaceを置かない。
