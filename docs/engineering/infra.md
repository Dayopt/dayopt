---
status: current
last_verified: 2026-09-16
---

# インフラ・環境・API/Routing 総覧

環境構成（Local / PR Preview / Production）、CI品質ゲートのロードマップ、DNS 管理（Cloudflare）、Bot 対策（Turnstile）、API endpoints 総覧、Supabase 型自動生成、App Router routing 総覧、パフォーマンス監視の原則、開発コマンド一覧、マイグレーション/リリースチェックリスト、災害復旧手順、DB Migration Rollback 手順書、出口コスト台帳。「環境・デプロイ・シークレットは?」の正。

---

## 環境構成

Dayopt の標準ルートは `local → PR Preview → production`。Vercel Preview が production Supabase DB を触らないことを最優先にする。

### 環境一覧

| 環境           | Supabase                          | Vercel                                     | URL              |
| -------------- | --------------------------------- | ------------------------------------------ | ---------------- |
| **Local**      | `supabase start`                  | `pnpm dev`                                 | localhost:3000   |
| **PR Preview** | PR ごとの Supabase Preview Branch | Vercel Preview (`product`)                 | `*.vercel.app`   |
| **Production** | `dayopt` main                     | main merge で自動 promote（`promote.yml`） | `app.dayopt.app` |

web（`dayopt.app`）と product（`app.dayopt.app`）は別ドメインで配信する。web から product へは絶対 URL でリンクし、path ベースの Multi-Zones（web の rewrites で `/settings` や `/app-static` を product へ proxy する構成）は使わない。production で既に 404 になっていたため 2026-09-14 に設定を撤去した（#2747）。security headers の正本は各 app の `next.config.mjs` の `headers()` で、`vercel.json` には置かない。

persistent staging は常設しない。固定 URL が必要な Stripe / OAuth callback / closed beta 検証が出た時だけ、Vercel staging と Supabase persistent branch を追加する。

### テスト自動化の現在地

層ごとの責務・いつ回すか・回帰テストの基準・retry 方針・Actions 予算は [testing.md](testing.md) が正本。ここは suite ごとの現況だけを持つ。

| Suite                          | CI       | 現在の役割                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------ |
| Vitest unit（product / web）   | required | ロジックとcomponentの回帰検知                                            |
| Playwright `chromium`          | required | 認証必須含む `apps/product/src/lib/test/e2e` の全specをCIで実行          |
| Playwright `Mobile Chrome`     | required | `@mobile` tag の test だけを promote 層 3 で chromium と同じ実行に入れる |
| Storybook browser light / dark | promote  | collect・render・play・a11y。失敗時は通常の production 昇格を止める      |

e2e job は `supabase/setup-cli` + `supabase start` でlocal Supabase stackを立てる。認証必須specは `create-scoped-test-user.ts`（`apps/product/src/lib/test/e2e/`）でspecファイルごとに専用の使い捨てユーザーをservice role経由で作成する（#2246）。単一の共有test accountだと`workers`並列実行下でtRPCのin-memory rate limiter（userId単位）を超過するため、spec単位でaccountを分離してrate limit予算も分離している。旧`scripts/ci/create-e2e-test-user.mjs`（全specで単一accountを共有する方式）は撤去済み。これにより認証必須testも含めて全specがCIでskipされずに実行される。Mobile Chromeは全specを二重実行せず、`@mobile` tag を付けた mobile 固有の操作境界（長押し作成・Drawer・ヘッダーナビ）の test だけを持つ（2026-09-14、#2743。local 専用だった間に mobile の assertion が UI 変更に追従せず腐っていた）。Playwright Test Agents（planner / generator の opt-in 採用、healer は不採用）は 2026-07-13 に限定採用したが、3週間利用ゼロのまま E2E 追加が手書きで行われたため 2026-08-03 に撤去した。再導入する場合は Playwright に定義を再生成させ、リポジトリ固有制約（healer 不採用、単一フロー限定、`test.skip()` / 固定 wait / `networkidle` 禁止）を planner / generator へ戻す。healer 不採用と CI の正を `chromium` とする判断は撤去後も有効で、根拠は 2026-08-03-playwright-test-agents-retirement.md（削除済み、git 履歴参照） に引き継いだ。

### Supabase Project

| Project | Reference ID           | Region | 用途                          |
| ------- | ---------------------- | ------ | ----------------------------- |
| dayopt  | `yvglwblxrnrenfifsnje` | Tokyo  | production main + PR branches |

Supabase GitHub integration が migrations / Edge Functions / Storage buckets の deployment owner。GitHub Actions から `supabase db push` は通常実行しない。

### 環境変数の管理

#### 1Password master / replica

Secrets の正本は `docs/operations/secrets.md`。1Password は production / shared / optional staging の長寿命 secrets だけを管理する。PR Preview Branch credentials は 1Password に保存せず、Supabase / Vercel integration の ephemeral replica として扱う。

#### Vercel environment

```txt
Production → human の Supabase credentials
Preview    → Supabase Vercel integration が PR Branch credentials を注入
Development/local → .op-env.agent + op run
```

Preview environment に production Supabase credentials を手動設定しない。残っている場合は削除または Preview scope から外す。

#### `.op-env.agent`

repository root の `.op-env.agent.example` を `.op-env.agent` にコピーし、`op://` 参照だけを書く。実値・dummy secret・placeholder secret は書かない。

### Local Development

```bash
supabase start
pnpm dev
```

`pnpm dev` は `op run` 経由のまま。Supabase local が停止中なら自動起動し、`supabase status -o env` から URL / anon key / service role key を取得して、値を表示せずに product app へ渡す。`.env.local` の実値保存は禁止。

**Next.js が生成する `apps/*/AGENTS.md` / `CLAUDE.md` は指示の正本ではない。** Next.js 16 は `next dev` が AI coding agent を検出すると app 直下へこの 2 ファイル（`<!-- BEGIN:nextjs-agent-rules -->` ブロック）を書き出す。untracked のまま残ると `pnpm branch:finish` の worktree dirty 判定を止め、誰も書いていない指示が読み込まれる。両 app の `next.config.mjs` で `agentRules: false` にして生成を止め、`.gitignore` にも app 直下だけを対象にした保険を置いてある（[#2693](https://github.com/Dayopt/dayopt/issues/2693)）。既に生えてしまった分は `rm` してよい。`apps/product/src/AGENTS.md` のように repo が意図して置いた nested な指示ファイルとは別物なので、消す前に `git ls-files` で tracked かどうかを見る。

**Supabase の接続先は local 固定で、切り替え手段は無い。** かつて存在した `DAYOPT_SUPABASE_TARGET=op` は `.op-env.agent` の `op://agent/supabase/...` を使う escape hatch だったが、その参照先が production を指していたため廃止した（[#1929](https://github.com/Dayopt/dayopt/issues/1929)）。Supabase local が起動しない時は Docker Desktop を確認し、`supabase start` を手動で実行してエラーを読む。

### Migration

詳細は本ファイルの「マイグレーション & リリース チェックリスト」セクション。

- PR open: Supabase Preview Branch が作成され、migration と seed が適用される
- PR review: Vercel Preview が対応する Supabase Preview Branch を参照する
- main merge: Supabase integration が production に migration を適用する
- emergency only: 手動 `supabase db push`

### GitHub Actions Secrets

CI / E2E 用の build env は GitHub Secrets に残す。migration 用の `SUPABASE_ACCESS_TOKEN` / DB password は通常 workflow からは使わない。緊急手動 runbook 用に残す場合も、1Password master から同期し、値を出力しない。

### デプロイフロー

```txt
feature branch → PR
  ├── Supabase Preview Branch
  └── Vercel Preview (product)
        ↓
      review
        ↓
main merge
  ├── Supabase main deployment
  └── Vercel Production build（domain 未割当の candidate）
        ↓
      Production Release workflow（push: main で自動起動）
        ├── impact（各 project の live SHA からの差分で層 3 の要否を決める）
        ├── 層 3（影響のある suite だけ。E2E / Web Build & E2E）
        └── release（影響判定 / smoke / audit）
        ↓
      promote（affected な project のみ）→ Production domain
        ↓
      両 production domain の smoke
```

**promote は 2026-09-03 に merge 連動の自動実行へ戻した**（#2268 の手動 dispatch を撤回）。
手動 dispatch は break-glass（`force`）と drill 専用に残る。安全は「影響のある層 3 が
**同一 run で** green」であることで担保し、層 3 の判定は check-run 名の照合ではなく
`needs.*.result` で行う。層 3（E2E / Web Build & E2E）は nightly.yml から promote.yml へ
移設した — #2382 が per-merge の層 3 を廃止した根拠は「promote が手動だから赤い main は
ユーザーへ届かない」で、merge 連動にするとその前提が反転するため。integration は
per-PR（ci.yml）へ一本化した（`branch:finish` の up-to-date gate により merge commit の
tree は per-PR で検証済みの tree と一致する）。

**Ignored Build Step が production build を決して skip しないこと（§merge gate）は、この設計の
前提でもある。** docs のみの merge でも candidate deployment が存在しないと、release job が
現れない build を待ち続ける。

Vercel の正規 deployment source は `Dayopt/dayopt` の GitHub 連携だけとする。
Preview は branch push / PR、Production build は `main` merge から作成する。CLI、REST API、Deploy Hook、
Marketplace integration、v0 から新規 Production deployment を作らない。

### merge と Production 公開の分離

main merge は Production domain を**直接**切り替えない。切り替えるのは `promote.yml` の release job
だけで、それが走るのは影響のある層 3 が green の時に限る（層 3 が赤い merge では promote されず、
production は現行 SHA のまま無傷で残る）。

gate が機能する前提は **Product / Web の Auto-assign Custom Production Domains が無効**であること。
これを無効化するまで main merge は従来どおり直接公開され、release workflow は素通りする。

**この移行は 2026-08-05 に完了した**（#1817 の project 設定監査が「`RELEASE_EXPECT_AUTO_ASSIGN: ''`
のまま live が true に固定され、素通り状態が続いていた」未完了を検出したのを受けて実施。
手順は次の 3 段で、再度必要になった場合も同じ順序で行う。Production 設定の変更なので
ユーザーの明示承認下で行う）:

1. Vercel Dashboard → product / web → Settings → Git
2. Auto-assign Custom Production Domains を OFF にする（web を先に、動作確認後 product）
3. 両方 OFF にしたら `.github/workflows/promote.yml` の `RELEASE_EXPECT_AUTO_ASSIGN` を `'false'` にする

無効化後は、main への merge が作るのは domain 未割当の Production build だけになり、Production domain の
切り替えは `.github/workflows/promote.yml`（`Production Release`）の promote だけが行う。
workflow は次を満たした時だけ promote する。

「今どれが配信しているか」は **production domain の alias** から引く。`/v9/projects/{id}` の
`targets.production` は production target の**最新** deployment を指し、build 中でもその値になるため
使えない（merge の 8 秒後、build 完了の 60 秒前に新 deployment を指すことを実測した）。

- **その merge の影響を受ける project**の Production build が対象 SHA で `READY`
- 各 candidate の unique URL への read-only smoke が成功（Deployment Protection があるため
  Protection Bypass for Automation の secret が必須）
- live な Vercel metadata に対する Production Config Audit が成功
- promote 後、`dayopt.app` と `app.dayopt.app` の両方への smoke が成功

**どの project を進めるかは project ごとに判定する。** 基準は「その project が今配信している
deployment の source SHA」で、そこから対象 SHA までの `git diff` を Impact Resolver
（`scripts/ci/impact.mjs`）に通す。web が 3 commit 遅れていても、判定は web の live SHA から見た
差分で行う。判定不能（source SHA 不明 / 履歴が checkout に無い）は affected へ倒す
（fail closed）。どの app にも影響しない merge では promote を行わず、`Production Release` status は
**success**（`unaffected`）になる — production の artifact がその commit と等価だから、tag は打てる。

**影響判定は 2 回・別の時刻に行い、その食い違いを不変条件で塞ぐ（#2574）。** 層 3（e2e / web）を
走らせるかは `impact` job が run 開始時点（T0）の live production SHA を基準に決め、実際にどの
project を promote するかは `release` job が層 3 完了後（T1、最大 20 分後）の live SHA を基準に
**独立して再計算する**。live が前進するだけなら `diff(base_T1..Y) ⊆ diff(base_T0..Y)` なので T1 の
affected 集合は T0 の subset になり、テスト範囲は superset で安全。**破れるのは Vercel Instant
Rollback で live が後退した時だけ**で、その時 T1 だけが affected になり、層 3 を一度も走らせていない
project を promote しうる（gate 式は `needs.impact.outputs.*_affected == 'false'` で層 3 を免除する
ため、workflow 側では止まらない）。そこで `production-release.mjs` が **「promote 対象 ⊆ impact が
affected と判定した project」** を promote 前に強制する。impact の verdict は release job の step env
（`RELEASE_IMPACT_<KEY>_AFFECTED`）で渡し、**`'true'` 以外はすべて未検証として扱う**（配線が落ちた
時に fail open しないため）。破れた run は production を 1 件も触らずに落ち、manifest の
`status: impact-mismatch` として残る（復旧は rollback ではなく再 run。[runbook.md](../operations/runbook.md)
Playbook 2 ケース0-B）。`force`（break-glass）は層 3 job 自体を skip する経路なのでこの検査も免除する。

smoke は promote 対象だけでなく **全 candidate に毎回走る**。Auto-assign が有効な段階適用中は
candidate が待機中に自動割当されて promote 対象が空になるため、promote 対象だけを smoke すると
cutover まで smoke のコードパスが一度も実行されない。全 candidate に走らせることで、毎 merge が
smoke と bypass secret の実働テストになる（bypass secret は登録済み。未登録の間は release run が
毎回失敗し、`Production Release` status が failure になって tag を打てない）。

promote 後は **両 production domain** を smoke する。片側だけ進んだ production はその組み合わせが
初めて世に出る状態で、実際に配信している domain の健全性は candidate 単体の smoke では出ないため。
この smoke には bypass secret を送らない（production domain に Deployment Protection が付く設定事故
そのものを捕まえる）。失敗した場合は **この run が promote した project だけ**を rollback する。
promote していない側の失敗でも rollback する — cross-app 破損ではそれが唯一の復旧手段だから。

**検出できるのは smoke check に載っている経路だけ**で、cross-app の破損一般ではない。web から
product への唯一の入口である signup CTA（`app.dayopt.app/auth/signup`）は product の check に含めて
あるが、それ以外のリンク切れは検出しない。Force Promote ではこの smoke も skip される（break-glass は
gate を全て飛ばす）。

promote 順は web → product に固定し、2 つ目が失敗した場合は 1 つ目を直前 deployment へ自動 rollback する。
この run が promote していない project（前の run から対象 SHA を配信している側など）は戻し先を持たない
ので rollback 対象にせず、run summary で名指しする。失敗時は Production domain が現行 SHA のまま
維持される（fail-safe）。

run の結果は `release-manifest-<attempt>` artifact（保持 90 日、`github.run_attempt` で名前を分ける。
同名 artifact は同一 run 内で 2 度 upload できないため、re-run した run でも attempt ごとに manifest が残る）
に残る。project ごとの deployment ID・source SHA・判定理由が入っており、**project 間で live SHA が
分かれた時に production の実態を読む一次情報**になる。run summary にも同じ JSON が出る。

対象 SHA より新しい Production deployment が既に live の場合は promote せず、`Production Release` status
を failure にする。live でない commit に tag を打てないようにするためで、run 自体も失敗として扱う。

**Vercel 側の既知バグへの対処**: promote endpoint は project 設定の `autoAssignCustomDomains` を
`true` へ戻す（[vercel/vercel#15095](https://github.com/vercel/vercel/issues/15095)、未修正）。放置すると
次の main merge が gate を通らず直接公開される。release script は promote / rollback の直前に観測した値を
そのまま復元する。無効化していれば無効のまま、段階適用中で有効なら有効のままになる。

### release workflow の信頼境界

`promote.yml` は Vercel の promote / rollback 権限を持つ token を扱う。実行する script は常に
**その run の ref のもの**を使う。release 対象は常に `github.sha` で、呼び出し側が任意の SHA を
指定する口は持たない（`sha` input は 2026-09-03 に廃止した。層 3 を同一 run で走らせる設計では
checkout と異なる SHA を検証できず、`checkoutAtTarget=false` の fail closed により
「未検証 × 全 project promote」の組み合わせしか作れないため。古い SHA を本番へ戻すのは promote では
なく rollback で、Vercel Instant Rollback / runbook Playbook 2 が正しい経路）。この制約は
`scripts/ci/release-workflow-contract.test.ts` が回帰から守る。

`github.sha` が main に merge 済みであることは compare API で確認する。push: main の run では自明だが、
`workflow_dispatch` は任意 ref から起動できるため無条件に検証する。ただしこれは「merge 済みか」の
確認であって、コード実行の防御ではない。

**残存リスクの現状**: `actions: write` を持つ主体が main 以外の ref から dispatch すると、その ref の
script が Production secret 付きで動く。YAML の条件では塞げない（攻撃者の branch では条件ごと消せる）。
これは `environment: production-release` の **deployment branch policy で閉じてある**（2026-09-01 実測:
custom branch policies、許可は `main` のみ、required reviewers なし）。main 以外の ref からの dispatch は
job 開始前に GitHub 側で拒否される。

**この environment に required reviewers を付けてはいけない。** merge 連動の自動 promote が承認待ちで
timeout する。付ける必要が出た場合は promote.yml の設計ごと見直す。

残る任意の追加措置: `VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB` だけを
repository secret から environment secret へ移すと、secret の露出範囲がこの job に限定される
（対象は promote.yml しか読まない bypass secret 2 つに限る）。

**`VERCEL_TOKEN` と `VERCEL_ORG_ID` は repository secret のまま残す。** `production-config-audit.yml` の
audit job は `pull_request_target` と `push: main` で走るため `environment:` を宣言できず、repository
scope でこの 2 つを読む。environment secret へ移すと Production Config Audit が起動直後に落ちる。
このため手順 3 の目的（露出範囲の限定）は bypass secret のみの部分達成になる。

いずれも Production 経路に触る設定変更なので、実施はユーザーの明示承認下で行う。

緊急時は正常な既存 deployment の `Instant Rollback` / `Promote to Production` を使う。手順は
[runbook](../operations/runbook.md) の Playbook 2 を正とする。

Deployment Policies による強制は 判断ログ（削除済み、git 履歴参照） を参照する。

### release の並行性モデル

策定日: 2026-08-05（PR #1820 のレビュー 30 ラウンド超を受けて保証境界を確定）

release script は Vercel API への read-modify-write で、API にトランザクションは無い。「読んでから書くまでに状態が変わる」窓（TOCTOU）は原理的にゼロにできないため、窓を潰し続けるのではなく **single-writer 前提 + fail-safe** で守る。

前提（運用で守る）:

- **書き手は同時に 1 つ。** CI は `promote.yml` の release job が持つ **job レベル** concurrency
  （group `production-release`、cancel なし）で直列化される。**workflow レベルには置かない** ——
  層 3 を内包した workflow 全体を 1 group にすると、GitHub は group ごとに pending を 1 本しか
  保持せず新着で古い pending を cancel するため、burst（実測 1 時間に 1〜3 merge）の 2 本目が
  promote されないまま消える。層 3 の 2 job は suite 別・ref 別の group（cancel あり）を持ち、
  新しい push が古い run の同種 job だけをキャンセルする。キャンセルされた job は
  `needs.<id>.result == 'cancelled'` になり、その run の release job は不成立で skip される
  （= promote しない。次の push の run が live 基準で拾い直す）
- **release run の実行中に、人手で Vercel の promote / rollback / alias 操作をしない。** 緊急時も run の完了（または cancel の完了）を待ってから [runbook](../operations/runbook.md) Playbook 2 に従う

script が保証すること（コードで守る）:

- **自分が知らない deployment を上書きしない。** live が「この run の candidate」でも「記録済みの previous」でもなければ `moved-externally` として触らずに fail する。alias 未割当（live なし）も「他者が意図的に外した」として同じ扱いにする
- **読めない状態では書かない。** live の読み取りに失敗したら rollback せず、人の確認へ回す（fail closed）
- **観測した外部変更は manifest に載せる。** 分類は単一の観測 map（`observedLive`）から導く

保証しないこと:

- **外部変更の検出の完全性。** 最後の read と write / return の間に起きた変更は検出できない。再読み込みを何回足してもこの窓は消えず 1 段深くなるだけなので、検出のための再読み込みはこれ以上追加しない
- **manifest の最終正確性。** manifest はベストエフォートの観測記録であって production の正ではない。実態は常に Vercel Dashboard を正とする

この境界の内側（「窓をもう 1 段狭めよ」型）のレビュー指摘は個別対応せず、本節を根拠に見送る。境界そのものを破る指摘（知らない deployment を上書きする、読めないのに書く、観測したのに manifest に載せない）は従来どおり修正する。打ち切りの一般規約は `AGENTS.md §PR / git 運用` §レビュー を参照。

### トラブルシューティング

| 症状                                    | 対処                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Supabase PR check が出ない              | Supabase GitHub integration / required check 設定を確認                        |
| Vercel Preview が production DB を見る  | Vercel Preview env から production Supabase vars を削除し integration を再同期 |
| migration が Preview Branch で失敗      | Supabase deployment log を確認し、migration を修正して PR branch に push       |
| Production に反映されない               | `gh run list --workflow=promote.yml` で promote が成功しているか確認           |
| Supabase 側が Production に反映されない | Supabase GitHub integration の production deployment log を確認                |

---

## CI 品質ゲート

現在有効な job と依存関係は `.github/workflows/ci.yml` を正とする。ローカルの標準入口は `pnpm check`、個別コマンドは `CLAUDE.md` を参照する。

### GitHub品質サービス

GitHub Code QualityはOrganization / Repositoryの両方で無効にし、PR品質ゲートには採用しない。追加のActions利用・active committer課金を避け、保守性・信頼性の検査は既存のCI、自動コードレビュー、下記のセキュリティ静的解析で担保する。

- Required checksはrepository rulesetと`.github/workflows/ci.yml`を正とし、Code Quality由来のcheckを追加しない
- **GitHub CodeQL は 2026-08-11 に無効化すると決めた。UI 操作は本記述時点で未実施で、現在も CodeQL は動いている**（残作業は #1934。現在状態は `gh api repos/Dayopt/dayopt/code-scanning/default-setup --jq '.state'` が `configured` を返すか `not-configured` を返すかで判定する。`not-configured` を確認したらこの一文を完了形へ更新する）。無効化を決めた理由は次のとおり。 default setup が `languages: ["actions"]` で有効化されており、**workflow YAML しか解析していなかった**（`apps/` 配下の JS / TS は対象外）。#1425 の Done 条件「JavaScript / TypeScript が対象になっていることを確認する」が満たされないまま COMPLETED で close されたため、誤った前提が docs 側に残り続けていた。無効化後のセキュリティ静的解析の担当: secret は gitleaks と `pnpm secrets:check`（#2483 以前は `.github/workflows/docs-guard.yml`、現在は `ci.yml` の static job（`scripts/ci/check.mjs`））、依存は Dependabot、深掘り SAST は `/claude-security`。**`.github/workflows/**` に対する PR ごとの自動解析だけは代替が無く、無効化で失われる**（受容済み。根拠と再評価の条件は決定ログ）。再有効化する場合は `languages` に `javascript-typescript` が入っていることを `gh api repos/Dayopt/dayopt/code-scanning/default-setup` で確認する（設定画面を開いた事実では確認にならない）。判断は2026-08-11 の決定ログ（削除済み、git 履歴参照）
- **自動レビューの履歴と現在の入口**: 2026-08-03 に Gemini の ai-review と Copilot を撤去し、Codex の GitHub review も適用範囲を変更してきた（当時の判断・実測は git 履歴を参照）。現在の PR 独立レビューは、リスクにかかわらず GitHub の `@codex review` を使う。追加 reviewer は 2026-09-17 の User 指示で停止中で、可用性や無応答を理由に自動起動しない。現在の規則は `AGENTS.md` §レビュー規則、手順は `.agents/skills/pr-cross-review/SKILL.md`
- **repo ruleset「Copilot automatic first review」は 2026-08-05 に削除した。** 上記の「外した」後も ruleset 自体は active で残っており、seat 付与後に復活したのか直近 PR（#1832）へ実際にレビューを投稿し、PR ごとに約 3 課金分の Actions 実行を発生させていた。private 化後の課金源かつ（当時の）Codex 一本化方針と二重のため ruleset ごと削除。再開する場合は org の Copilot seat 割り当て（Settings → Copilot → Access）と ruleset の再作成の両方が必要
- カバレッジ閾値が必要になった場合はVitest / CIで直接管理する
- Code Qualityを再評価する場合は、有効化前にbilling impactと既存品質ゲートとの差分を確認する

Code Qualityを採用しない判断と2026-07-21時点の外部設定証跡は判断ログ（削除済み、git 履歴参照）に記録する（同ログは「セキュリティ静的解析はCodeQLを継続する」とも書いているが、その1行は上のとおり2026-08-11に覆った）。

- Edge Function（`supabase/functions/**`）の型検査は Static Checks job の `deno check` step（`pnpm functions:check`）が担う。tsconfig / `pnpm typecheck` の対象外（別ランタイム）で、`supabase/functions/**` を変更した PR でだけ走る（#1822）
- `Production Contract`は安全なdummy値だけを使い、Product / WebのProduction build gateがResend、Upstash、Web Turnstileを要求することを検査する
- `Production Config Audit`はtrusted base revisionのscriptだけを実行し、Vercel APIからenvのkey / target / typeだけを検査する。secret値は取得・出力せず、PR codeへVercel tokenを渡さない
- `RESEND_API_KEY`と`RESEND_WEBHOOK_SECRET`はProductionだけをtargetにし、Preview / Developmentへの設定をaudit failureにする
- workflow導入PRでは`pull_request_target`がまだbaseにないため、同じscriptをmetadata-onlyで手動実行し、merge後の初回trusted run成功後にrequired statusへ昇格する
- **project 設定 6 項目も監査対象（2026-08-05、#1817 Phase 4 で 4 項目導入 → #1835 で
  `sourceFilesOutsideRootDirectory` 追加 → 2026-08-14、#1966 で `functionDefaultTimeout` 追加）。**
  `GET /v9/projects/{idOrName}`（`scripts/ci/production-release.mjs`の`getProjectMeta`と同系API）を
  追加で叩き、`rootDirectory`（product=`apps/product`、web=`apps/web`）・
  `autoAssignCustomDomains`（false）・`commandForIgnoringBuildStep`（null/未設定。
  vercel.jsonの`ignoreCommand`が正本で、dashboard側に別コマンドが残っていたらdrift）・
  `enableAffectedProjectsDeployments`（"Skip deployments"、無効）・
  `sourceFilesOutsideRootDirectory`（有効。falseだとignoreCommandがfail openになる）・
  `resourceConfig.functionDefaultTimeout`（60。Dashboard Functions タブの
  "Default Max Duration"）を照合する。フィールドが応答に無い場合もfailure（fail closed）。
  値そのものは出力しない（env監査と同じ方針）。前半5項目のフィールド名はVercelの公開OpenAPIスペック
  （<https://openapi.vercel.sh>）で確認したが、`functionDefaultTimeout`は同スペックに掲載が無く
  `vercel/sdk`の型定義（`GetProjectResponseBody`の`resourceConfig`配下）で確認した
  — 実応答での存在は trusted dispatch の green が唯一の実測（詳細は上記
  §Dashboard の Default Function Timeout 参照）
  - **`scripts/ci/production-release.mjs`のrelease gate（`runProductionConfigAudit`呼び出し2箇所）は
    `checkProjectSettings: false`で呼び、この6項目監査をスキップする。** `autoAssignCustomDomains`
    はrelease中に一時的にtrueへ戻りうる（Vercelのpromote endpointの既知挙動、
    vercel/vercel#15095）。production-release.mjs側はsweep/stabilizeで自前管理しており
    （gate実行中に外部promoteが起きて再びtrueになってもfinallyで掃き直す設計）、6項目監査は
    「定常状態のdrift検出」が目的の静的チェックなのでrelease実行中の一時的な状態と衝突する。
    env監査（key/target/type）はrelease gateでも従来どおり実行する

### 共通検証計画の shadow（#2793 / #2794）

`validation-shadow.yml` は ready PR の base checkout にある `validation-plan-shadow.mjs` を実行する。
PR 側は git diff のデータとして読み、依存 install やスクリプト実行には使わない。
base の policy / workspace manifest、head、実際の merge revision、完全な patch hash を固定し、
削除・rename の両側を含めて分類する。base に producer がない導入 PR は bootstrap pending と表示し、
有効な計画や検証成功とは数えない。取得失敗・不明な revision は成功計画を作らない。

schema v1 の計画は Actions summary と `validation-plan` artifact（14 日）に残る。
`required` / `not-applicable` / `indeterminate` を検査ごとに記録し、README の説明文と
AGENTS・skills・実行される MDX・契約文書を区別する。コードのレビュー要件から本番操作の
承認を推定しない。計画は宣言であり、CI / review / deployment の成功証拠ではない。

現段階は **shadow のみ**。既存の必須 check、skip、release、ruleset は変更しない。
この workflow 自体は PR 側で変更できるため、その artifact を信頼済み合格証拠として採用しない。
後続 #2795 の controller が信頼済み source と revision を照合し、#2798 の比較・承認後に切り替える。
base 規則の変更は次の PR から有効になり、当該 PR 自身の必要条件を緩めない。

### Validation の信頼済み controller（#2795、shadow）

`validation-gate.yml` は `workflow_run`（CI 完了）、`status`（Vercel の commit status が
success / failure / error になった時。pending は除く）、`issue_comment`（PR への comment の
created / edited。`@codex review` 依頼、Codex の完了 comment と summary 表の編集、
`[review-summary]` を拾う）で、**main の workflow 定義と checkout** を使って `scripts/ci/validation-gate.mjs` を実行する。
どちらも GitHub docs で「workflow file が default branch にある時だけ走る」event。`deployment_status` は使わない: この event は
deployment の commit（PR head）の workflow 定義で走る（2026-09-17、PR #2804 で実測）。
`workflow_dispatch` も使わない: 任意 ref の定義で起動でき、PR branch で改変した controller が
statuses:write 付きで走る（Codex review P2）。手動再評価は Actions の「Re-run jobs」。
Vercel Preview が CI より遅れる分は job 内で短く待ち（`VALIDATION_WAIT_MINUTES`）、上限後の
完了は `status` event が再評価する。controller は評価開始時に pending を発行し、収集・評価が
例外で落ちても（pending の発行自体が失敗した場合も含めて）failure の発行を試みてから終了する
（以前の success が偽の green として残らない）。合成 merge commit の日時は固定値で、同じ
base / head / tree なら再評価でも同じ testSha・planId になる。
controller 自身も `GITHUB_REF` が main でない・event が workflow_run / status でない場合は
評価も発行もしない。**PR が producer 定義（ci.yml / setup action / check.mjs / impact.mjs）を変えている
場合、その PR 自身の CI run は `self-produced` として信用しない**（job 名を保ったまま step を
空にできるため）。この保証境界は job の配線ファイルまでで、vitest 設定や scripts の改変は
review の観点に残る。PR 側のコード・依存・artifact は実行しない。
計画は毎回 base policy から再生成し、validation-shadow.yml の artifact は読まない。test merge は
GitHub の `refs/pull/N/merge`（遅延更新で base が古いことがある）ではなく、main HEAD と
`refs/pull/N/head` から `git merge-tree` で自前生成する。PR の tree は git object として diff に
読むだけで実行しない。conflict は indeterminate。

証拠は GitHub API から取り、controller が import する純粋な評価関数（validation-evidence）が判定する。
producer は workflow path + job 名 + `pull_request` event + head SHA + repository で照合し、
同名 check を別 workflow が出しても採用しない。同一 head の複数 run は最新 run の最新 attempt
だけを見る。Preview は commit status の緑に加えて、同じ SHA の `Preview – product` /
`Preview – web` deployment とその最新 status を要求し、production environment は拒否する。
必要 suite は明示的な success だけが satisfied で、skipped / cancelled / timed_out / 不在 /
計画 indeterminate はいずれも合格にしない。計画上 not-applicable
だけを理由付きで受理する。層 3（E2E / Web smoke）は promote.yml が merge 後・公開前に生産する
証拠として `deferred` に分け、merge 判定には含めない。base が進んだ head は `update-branch` として
pending（strict up-to-date の ruleset と同じ向き）。

DB / Preview の証拠（#2797）: `dbFresh` は `🧪 Integration Tests`（candidate の migration 集合を
空 DB へ適用）、`dbUpgrade` / `oldConsumer` は `🧱 DB Upgrade (shadow)`（base の migration 集合 +
**base の seed** まで reset し、PR が追加した migration だけを当てて、適用エラー・seed 行の消失
（table ごとの件数と主キーによる同一性。同数の入れ替えも落とす）・fresh との schema 不一致
（生成型と、index / constraint / trigger の catalog snapshot の両方）・base 世代の生成型が参照する
オブジェクトの消失や契約変更（列の型・nullability、Insert / Update の型と optional → required、
Insert の新規必須列、view の列、RPC の引数名・型・必須性と Returns）を別々に検出する。
`scripts/ci/db-upgrade-check.mjs`。migration を追加した PR だけ走り、非必須。この script を
migration と同時に変えた PR の緑は `self-produced` として信用しない）。**保証境界**: 既存データと
catalog の対象は `public` / `auth` / `private` schema、old-consumer の契約は commit 済み生成型
（`database.types.ts`）に現れるもの（table の Row / Insert / Update / Relationships、view の Row、
function の Args / Returns、enum 値）に限る。生成型に現れない契約（RLS の意味、trigger の挙動、
extension、storage）は RLS snapshot・integration test・レビューが担い、この job は証明しない。
この境界の内側への点追加は fix ではなく境界の記述で応答する（AGENTS.md §レビュー）。追加分は timestamp に関わらず
reset から退避し、seed は base SHA の内容に差し替えるので、candidate の seed から旧形式の行を
消しても「旧データに当てる」経路を通る。fresh 成功を
upgrade 成功の代用にしない。適用済み migration の編集・削除は production が再実行しないので
落とす。schema 変更を含む PR の `Preview – product` は、同じ SHA の `Supabase Preview` check run
（発行元が公式 Supabase App `supabase` のもの）が success（隔離された PR 用 branch）であることも
要求し、skipped（branch 無し = shared / 不明な DB）や別 App の同名 check は受理しない。check run が
まだ無い間は pending（controller が bounded に待ち、`check_run` 完了 event で再評価する。missing と
して blocked にはしない）。app-only の PR には branch を要求しない（integration は migration を含む PR
でだけ branch を作る）。

公開前の migration 反映確認: promote.yml の release job が
`scripts/ci/production-migration-readiness.mjs` で候補 SHA の migration 集合が production の
`schema_migrations` に全て入っているかを read-only Management API で見る（integration の非同期
反映を最大 6 回 × 30 秒だけ待つ。適用・再試行はしない。writer は Supabase integration のまま）。
**現状は token を渡しておらず常に advisory（warning）。**
有効化は別変更で、read-only token を `production-release` environment へ置く決定（secret の
境界変更、User 裁可）と台帳（`docs/operations/secrets.md`）・同期 script・
`ci-secret-ledger.test.ts` の同時更新を伴う。有効化後は欠落が promote を止める（force では飛ばす）。

同じ controller が Review policy（#2796）も評価する: 計画の `review` 要件と PR の review /
comment / thread（GraphQL の resolve 状態）から `not-required` / `not-started` / `pending` /
`stale` / `complete` / `pending-adjudication` / `unknown` を判定し、commit status
`Review policy (shadow)` に出す。状態の定義と完了証拠は `pr-cross-review` skill §Review policy。
追加 reviewer は停止中。保護対象 path でも現 head の GitHub レビューと指摘の裁定で満たし、
固定差分レビューの欠落・古さ・partial を別の停止条件にしない。既存証跡の読み取り互換は維持する。
shadow 中は Codex を自動起動しない（workflow に `pull-requests: write` を渡していない）。
review evidence の保証境界: review の submit と thread の resolve は issue_comment を出さないため、
その直後は再評価されない。通常は修正 push → CI 完了の `workflow_run` で再評価される。
`pull_request_review` 系は PR 側の定義で走るため trigger にしない。reviewThreads は cursor で
最後まで読み、応答が欠けた時は failure を発行する。`[review-summary]` と `@codex review` 依頼は author_association が
OWNER / MEMBER / COLLABORATOR の comment だけ受理し、`status:` は単独の `reviewed` か全要素が
`role=reviewed` の時だけ満たす。依頼と head の対応は commit 日時ではなく、その head の最新の
pull_request run 作成時刻（切替時刻）で照合する。Codex が無応答 / 失敗でも、現 head の信頼済み
`[review-summary]` があれば、過去に記録されたレビュー証跡の互換経路として満たす（新しい reviewer は起動しない）。
closed / merged PR と main 以外を base にする PR は評価も発行もしない。裁定は PR の全 review
thread（代替レビューの指摘・対象不明の応答を含む）が「信頼済み人間の返信つきで resolve」で
なければ pending-adjudication。**review evidence の保証境界はここまで**: GitHub 上の投稿者・
association・thread の resolve 状態を機械確認するもので、返信内容の妥当性や、GitHub の外で
行われた確認は証明しない。

結果は Step Summary・`validation-result-<run>` artifact（14 日）・commit status `Validation (shadow)`
に出す。**required check ではない。** ruleset・`branch:finish`・既存 check は変更しない。
GitHub native rule の管理者 bypass はこの check では防げない（bypass actor 0 の ruleset が担う）。

### 新旧ゲートの切替計画と rollback（#2798）

比較は `pnpm validation:shadow-report [--limit N] [--json]`（read-only。直近の非 draft PR について、
旧経路で実際に走った job（failure / cancelled 含む）・Vercel status・runner 分・CI 秒、**実行した
checkout の policy で遡及評価**した plan（各 PR の base 時点の policy ではない。header に checkout
SHA を出す）、controller が発行した `Validation (shadow)` / `Review policy (shadow)`、would-skip /
would-add（Actions job と Vercel deployment の両方）を 1 表にする。取得できない runner 分は
未取得、plan が indeterminate の行は比較を未判定とし、0 や削減可能に丸めない。判定は人が行い、
件数の少ない分類の p95 は出さない。Preview / review の待ち時間は未取得）。

**順序: shadow 観察 → 比較 → 承認付き切替 → 観察 → 整理。既存の必須条件を先に削らない。**

| 段階 | 変更                                                                                                                                                                              | 戻し方                                   | 承認                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- |
| 0    | shadow（現状）: `Validation (shadow)` / `Review policy (shadow)` / `🧱 DB Upgrade (shadow)` は非必須                                                                              | workflow を Disable                      | 不要（AUTONOMOUS）         |
| 1    | 比較レポートで docs / ui / logic / api-db / ci-policy 別に正例・負例と保証の退行が無いことを確認                                                                                  | -                                        | -                          |
| 2    | ruleset に `Validation (shadow)` と `Review policy (shadow)` を **既存 required と併走で追加**（旧条件は残す。片方だけだと Review policy が pending / blocked でも merge できる） | ruleset から context を外す              | User（CHECKPOINT）         |
| 3    | 観察後、旧 required のうち新条件が包含するものだけを外す（trusted source を保つ native check は残す）                                                                             | その PUT 直前に保存した ruleset を再適用 | User（EXPLICIT AUTHORITY） |
| 4    | `branch:finish` の rollup 検査と shadow の重複を整理                                                                                                                              | git revert                               | -                          |

**段階 2 の前提（発行元の分離）**: `Validation (shadow)` / `Review policy (shadow)` は現状
validation-gate.yml が `GITHUB_TOKEN`（github-actions App、integration_id 15368）で発行している。
同一 repo の PR workflow も `permissions: statuses: write` を宣言すれば同じ App 名義で同じ context を
head SHA へ POST できるため、context 名（+ integration_id 15368）だけで required にしても「main の
信頼済み controller が評価した」証拠にならない（status event の再評価は Vercel context だけを
見るので、偽 status を controller が上書きする保証もない）。required 化の前に次のどちらかを
User 裁可で決める: (a) controller の status を専用 GitHub App の installation token で発行し、
ruleset の `required_status_checks[].integration_id` をその App に束縛する（推奨。PR workflow は
その App の token を得られない）、(b) repo の Actions 既定権限を read に固定したうえで、PR
workflow の `permissions` 宣言による昇格を組織 policy で禁止できることを実測してから進める。
どちらも未実施の間は段階 2 へ進まない。

切替は `gh api -X PUT repos/Dayopt/dayopt/rulesets/6790553` で行い、**各 PUT の直前に
`gh api repos/Dayopt/dayopt/rulesets/6790553` の完全な JSON をその操作固有の rollback 入力として
保存してから**実行し、直後に ruleset と対象 PR の check を再取得して旧条件と新条件の証拠を比較する。
rollback はその直前 snapshot を再適用する（下の固定値ではない。段階 3 までに別変更で required check が
増えていれば、古い一覧の再適用は gate を弱める）。全 gate 無効化や force 公開を復旧手段にしない。
名前だけ先に変えて永久 pending を作らない。

参考 snapshot（2026-09-17 UTC、`gh api repos/Dayopt/dayopt/rulesets/6790553`。監査用の参考値で、
rollback 入力ではない）:

```json
{
  "bypass_actors": [],
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/heads/main"] } },
  "enforcement": "active",
  "id": 6790553,
  "name": "Branch name pattern: main",
  "rules": [
    { "parameters": null, "type": "deletion" },
    { "parameters": null, "type": "non_fast_forward" },
    {
      "parameters": {
        "allowed_merge_methods": ["merge", "squash", "rebase"],
        "dismiss_stale_reviews_on_push": true,
        "dismissal_restriction": { "allowed_actors": [], "enabled": false },
        "require_code_owner_review": false,
        "require_extra_approval_for_unattributed_changes": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true,
        "required_reviewers": []
      },
      "type": "pull_request"
    },
    {
      "parameters": {
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "🔍 Static Checks", "integration_id": 15368 },
          { "context": "📦 Unit Tests", "integration_id": 15368 },
          { "context": "Vercel – product" },
          { "context": "Vercel – web" },
          { "context": "🧪 Integration Tests", "integration_id": 15368 }
        ],
        "strict_required_status_checks_policy": true
      },
      "type": "required_status_checks"
    }
  ],
  "target": "branch"
}
```

未有効化のもの（コード完了 ≠ 有効化。#2793 の受け入れ条件）:

- 公開前 migration 反映確認は promote.yml に advisory で配線済み。有効化は read-only token を
  `production-release` environment へ置く決定（secret の境界変更）と台帳更新を伴う別変更
- Codex の自動起動（Review policy の trigger）は log のみ。実起動は `pull-requests: write` を
  controller へ渡す判断を伴う別変更
- controller の status 発行元の分離（専用 GitHub App）は未実施。段階 2 の前提（上記）
- release 差分基準の回帰（前回公開失敗後の docs-only merge、同一 SHA の再 deployment、片方だけ
  未公開、burst merge）は `scripts/ci/release-impact.test.ts` / `scripts/ci/production-release.test.ts`
  の既存 fixture（live 基準判定、preview / 別 integration の deployment 除外、superseded、mixed
  release の rollback）が持つ。重複実装しない

### merge gate の required checks

**merge gate は main の ruleset `6790553`（`Branch name pattern: main`）1 本。** 2026-09-07 の repo public 化で有効になり、required status checks（`🔍 Static Checks` / `📦 Unit Tests` / `🧪 Integration Tests` / `Vercel – product` / `Vercel – web`）、strict up-to-date、review thread resolution 必須、bypass actor 0 を GitHub 自身が local / cloud / UI / API / MCP のどの経路でも同じ条件で強制する（実状は `gh api repos/Dayopt/dayopt/rulesets/6790553`）。2026-09-13 に [#2640](https://github.com/Dayopt/dayopt/issues/2640) で `Production Config Audit` を required から外し、`🧪 Integration Tests` を足した。ruleset は skipped な required check を成功扱いにするので、DB を触らない PR で integration job が skip されても止まらない。`pnpm branch:finish`（`scripts/tasks/finish-branch.sh`）は merge と worktree / branch 掃除の入口で、その rollup 検査（affected 判定による `🧪 Integration Tests` の名前要求、Vercel context の存在確認）は ruleset と重複する冗長検査として残す。gate ではないので、UI / API / MCP から直接 merge しても条件は変わらない。2026-09-07 までは Free plan の private repo で ruleset API が 403 を返し、gate は finish-branch.sh だけだった（旧記述）。

**private 化の前提（2026-09-14 決定、未実施）**: org を GitHub Team へ上げてから repo を private に戻す。Team の private repo では ruleset がそのまま強制されるので、merge gate は変わらない。**Free plan のまま private にすると上の旧状態（ruleset 不在、gate は finish-branch.sh だけ）へ戻る**ため、順序を逆にしない。切り替え後は ruleset が active のままか（`gh api repos/Dayopt/dayopt/rulesets/6790553 --jq .enforcement`）と、agent の fine-grained PAT で `gh pr view <N> --json statusCheckRollup` が空にならないか（`pnpm branch:finish` の rollup 検査が依存する）を実測する。

finish-branch.sh が名前で success を要求するのは `ci.yml` の 3 job（`🔍 Static Checks` / `📦 Unit Tests` / `🧪 Integration Tests`）に加えて次を含める。`🧪 Integration Tests` は 2026-09-02、[#2539](https://github.com/Dayopt/dayopt/issues/2539) で `📦 Unit Tests` から分離した。同じ #2539 で affected 判定を `🧭 Impact` job へ切り出し、`impact →（static ∥ unit ∥ integration）`の並列構成にしている（実測で CI 全体が 16 分 55 秒 → 6〜7 分台。run 33588708693 → 33615047182 / 33618057064。**この数値が構成の基準値の正本**で、`ci.yml` / `check.mjs` 側のコメントには数値を置かない）。**`🧭 Impact` は required にしない** — 下流 3 job は `needs.impact.result` を条件にせず、impact が落ちても空 output を fail closed（全実行）として受けて必ず走るため、検査そのものは常に行われる（この設計は Codex / 内製 risk-reviewer の P2 指摘で入れた。要求すると impact 障害時に全 job が skip され検査ゼロになる）。**`🧪 Integration Tests` は DB を触る PR でだけ走る**ため、`branch:finish` も affected な PR でだけ名前で要求する。

**`📦 Unit Tests` が走らせる package は `scripts/ci/check.mjs` の `runUnit()` が名指しで持つ**（`@dayopt/product` / `pnpm test:web` / `pnpm test:scripts` / `@dayopt/billing` / `@dayopt/i18n` / `@dayopt/observability`）。root の `pnpm test:run` とは別経路なので、片方だけに package を足すと**ローカルでは走るのに CI では走らない** test ができる。実際 `@dayopt/billing` が root にだけ載っており、capability map（Free / Pro の正本）を守る test が CI の外にあった（2026-09-07、[#2646](https://github.com/Dayopt/dayopt/issues/2646)）。package を増やす時は両方へ足す。

**2026-08-20、CI 4 層再設計（[#2269](https://github.com/Dayopt/dayopt/issues/2269)）により `🎭 E2E Tests` / `🌐 Web Build & E2E` は required checks から除去した。** この 2 job は `.github/workflows/ci.yml` から `.github/workflows/heavy-post-merge.yml` へ移設され、pull_request では発火しなくなった（nightly + workflow_dispatch のみ。push:main は #2382（2026-08-25）で per-merge 実行のコストを理由に廃止済み）。旧記述（4 job が required）は誤り。#2483（2026-08-28）で `heavy-post-merge.yml` は `nightly.yml` へ吸収され、**2026-09-03 に `promote.yml` へ再移設した**（merge 連動 promote。per-PR で required にしない扱いは不変で、走るのは merge 後の promote 経路。影響のある suite だけが走る）。 詳細は 2026-08-20 の決定ログ（削除済み、git 履歴参照）、per-PR 検証の後継はレーンのローカル影響 spec 実走義務（`AGENTS.md §レーン運用` §条件付き事前 E2E）を参照。

required status checks の実状は ruleset が正本で、context の一覧をここへ写さない（`gh api repos/Dayopt/dayopt/rulesets/6790553 --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'` で引く）。

**過去に required だった 2 context は、もう存在しない**（2026-09-16 に旧記述を撤去）。`🛡️ docs & secrets guard` の検査は `ci.yml` の static job（`scripts/ci/check.mjs`）へ吸収され、内製クロスレビューの commit status `dayopt/internal-review` は 2026-09-04 のクロスレビュー廃止方針で撤去した（`pnpm review:marker` という script も無い）。`Production Config Audit` は 2026-09-13 に required から外し、nightly / 定期実行として残っている。

- `Vercel – product` / `Vercel – web` の区切り文字は en dash（U+2013）で、hyphen ではない
- **`branch:finish` は `🔍 Static Checks` / `📦 Unit Tests` / `🧪 Integration Tests` も名前で success を要求する（2026-08-26、[#2415](https://github.com/Dayopt/dayopt/issues/2415)。3 つ目は 2026-09-02、[#2539](https://github.com/Dayopt/dayopt/issues/2539)）。**
  Draft CI 廃止により、この 3 job は draft の間 `conclusion: skipped` の check run になる。skipped は
  失敗にも成功にも実行中にも数えないため、集約判定（失敗 0 / 実行中 0 / success 1 件以上）だけでは
  「draft 期の skipped が残ったまま ready 直後に merge」を通してしまう（success 1 件は draft guard を
  持たない docs guard が満たす）。影響判定が不能な場合は要求する側（fail closed）へ倒す。
  **docs-only で免除するのは `📦 Unit Tests` だけ**（Impact gate による skip が正当なため）。
  `🔍 Static Checks` は docs-only でも常に要求し、**`🧪 Integration Tests` は docs-only とは
  独立に `integration` affected な PR でだけ要求する**（2026-09-05、[#2552](https://github.com/Dayopt/dayopt/issues/2552)）。
  affected でない PR では job ごと skip されるのが正常で、無条件に要求すると永久に missing で止まる。
  逆に docs-only を integration の外側条件に置くと、`docs/engineering/data/db/rls-snapshot.md`
  のような「docs パスだが integration 対象」の PR で RLS drift 検査が一度も走らずに merge できる
  （#2552 で実際に空いていた穴。ci.yml の integration job の `if:` と同じ向きに揃える）。契約は
  `scripts/__tests__/finish-branch.test.ts` §軽量層（Static Checks / Unit Tests）の実走要求 が固定する
- **`ci.yml` / `scripts/ci/check.mjs` は `INTEGRATION_GLOBS` に含める（#2539）。** integration を独立 job へ
  切り出した結果、job まるごとが `if:` で skip されうるようになった。配線を持つこの 2 ファイルを
  中立扱いのままにすると、**配線を変えた当の job を一度も実走させずに merge** できる（`nightly.yml` を
  既に含めているのと同じ理屈）
- **`branch:finish` はこの 2 context を無条件には要求しない（2026-08-04、#1813）。**
  `scripts/ci/impact.mjs`（Impact Resolver）が PR の変更ファイルから affected な app を判定し、
  affected な project の context だけを success 必須にする。unaffected な project の context
  欠落は正常。変更ファイル一覧の取得失敗・未知 path・判定不能は両方必須へ倒す（fail closed）。
  判定仕様は旧 ci-monorepo-refactor overview §5（`docs/projects/_archive/ci-monorepo-refactor/overview.md`、
  docs/projects 全廃に伴い #2473 で削除。git 履歴参照）
- Vercel の check context は **project 名に由来する**。project を rename すると required check が一致しなくなり、
  全 PR が merge 不能になる。rename する場合は ruleset を先に更新する
- **Ignored Build Step は `apps/{product,web}/vercel.json` の `ignoreCommand` が正本**（2026-08-05、
  #1817 Phase 4）。dashboard 側の Ignored Build Step 欄は使わない（`commandForIgnoringBuildStep`
  は null/未設定が契約。§Production Config Audit 参照）。実体は
  `node ../../scripts/ci/impact.mjs --vercel <product|web>`（`../../` は Root Directory＝
  `apps/product` / `apps/web` からの相対 path）。exit 1 = build 続行、exit 0 = build skip という
  Vercel の契約に合わせ、Impact Resolver の判定結果を exit code へ変換する
  - **skip するのは preview build だけ。production build（`VERCEL_ENV=production`）は
    変更内容によらず常に build する。これは merge 連動 promote（§デプロイフロー）の前提でもある**
    ——docs のみの merge でも candidate が存在しないと、release job が現れない build を待ち続ける。 `VERCEL_GIT_PREVIOUS_SHA` は「直前の**成功した
    build**」であって live SHA ではなく、未 promote candidate を基準に skip すると
    Production Release が存在しない candidate を待ち続けて詰まるため
    （旧 ci-monorepo-refactor overview §8「移行順序・安全制約」の実施形態。
    `docs/projects/_archive/ci-monorepo-refactor/overview.md`、docs/projects 全廃に伴い
    #2473 で削除。git 履歴参照）
  - preview の基準は **`VERCEL_GIT_PREVIOUS_SHA`〜HEAD**（その project + branch の直前の
    成功 deployment の SHA。Ignored Build Step 設定時のみ露出）
  - **fail open を徹底する**（= build 側に倒す）。env 欠落、shallow clone（build container は
    `git clone --depth=10`）で SHA が履歴に無い、git 失敗、resolver 判定不能はすべて build。
    skip に倒れるのは「diff が取れて Impact Resolver が明確に false を返した」場合だけ
  - product の Vercel project 標準機能「Skip deployments (no changes to root directory)」
    （API: `enableAffectedProjectsDeployments`）は無効化しておく。workspace 依存グラフを
    見ないため `ignoreCommand`（依存グラフを見る）と競合する。無効化は **ignoreCommand を
    含む PR の merge より前**に行う（トグル → trusted dispatch → merge の順。逆だと
    dispatch の project 設定監査が落ちて merge できない）
  - **実 PR で検証済み**（2026-08-05、PR #1836。記録は
    log/2026-08-05-vercel-skip-verification.md（削除済み、git 履歴参照））。
    docs-only push で両 project とも build されず、head SHA には
    `Vercel – web` / `Vercel – product` が **`success`（description は
    `Canceled by Ignored Build Step`）で付く**。したがって「PR 全体では affected だが最終 push
    だけ unaffected（例: レビュー対応の docs 修正）」でも context は欠落せず、merge gate は
    止まらない。merge gate 側の fallback は不要
  - 検証時の注意: skip が観測できるのは **`ignoreCommand` を持つ成功 deployment が基準に
    なった後の push** から。`ignoreCommand` 導入前の main から切った branch や、それを取り込む
    merge commit（`apps/*/vercel.json` を含む）は当然 build される
- **未解決の review thread が 1 件でもあると `branch:finish` は停止する**（2026-08-04）。
  GraphQL `reviewThreads` を `pageInfo.hasNextPage` / `endCursor` で全ページ走査して
  `isResolved` を数える（2026-08-05、#1831。旧実装は first:100 の 1 ページのみで、
  101 件・未解決 0 の PR #1820 を偽陰性で止めた）。取得失敗・20 ページ（2000 件）超は
  従来どおり停止に倒す（fail closed）。解決の 3 択は `AGENTS.md §PR / git 運用` §レビュー
- `Production Release` は merge 後の証跡であり、required check にはしない
- **Storybook browser suite は `promote.yml` の専用 job で実行する。**
  product / web / 共有 UI / Storybook 設定の変更に対して、collect 検査と light / dark を実行し、
  通常の production 昇格条件と失敗通知に接続する。per-PR の全件実行は追加しない。
  詳細は [testing.md](testing.md#storybook-の実行契約)、実測証跡は #2737 / #2743 を参照。
- **`pull_request_target` の job でも check run は PR の `statusCheckRollup` に出る。**
  2026-07-30 に PR #1760 で実測: `production-config-audit.yml`（`pull_request_target`）の job が
  `Audit Vercel metadata (trusted)` という CheckRun として出ている。したがって trusted base 実行の
  workflow でも、gate のために commit status を自分で publish する必要は無い。
  `Production Config Audit` という StatusContext が別に存在するのは、job 名から独立した固定 context を
  持たせるため（`finish-branch.sh` の trusted dispatch 免除がこの context 名で照合する）。
  **ただしこの context を ruleset の required 指定に使ってはいけない**（2026-09-03、#2571）。
  PR で publish されるのは `pull_request_target` の `paths` に一致する contract 変更 PR だけになり、
  それ以外の PR では status も check run も存在しない。required にすると、2026-08-05 の
  `ci.yml` paths-ignore 撤去（PR #1836）と同じく「永久に `expected` のまま」で全 PR が
  merge 不能になる。**2026-09-07 の public 化で ruleset が有効化され、この落とし穴が実際に発生した**
  （全 PR が `mergeStateStatus: BLOCKED`、5 日で 34 回の手動 dispatch で回避。2026-09-13 に [#2640](https://github.com/Dayopt/dayopt/issues/2640) で required から外して解消）
- **外部モデルの自動 diff レビュー（ai-review / Gemini）は 2026-08-03 に撤去した。** 現在の
  PR 独立レビューは GitHub の `@codex review` で、追加の内部 / 外部 reviewer は停止中。
  旧レビューで蓄積した不変条件カタログは [invariants.md](./invariants.md) に残っている。
- `ci.yml` は docs / rules のみの変更でも **workflow 自体は起動し**、`gate` job（Impact Resolver）の
  判定を各 job の `if:` に配って skip する。**skip された job は required status check として success
  扱いになる**ため、実行コストを避けつつ merge gate も満たせる。`paths-ignore` は 2026-08-05 に撤去した
  （workflow ごと起動しなくなり、ruleset が required にしている 4 check が永久に "expected" のまま残って
  docs のみの PR が構造的に merge 不能になったため。PR #1836 で実測）。マージ可否は
  `scripts/tasks/finish-branch.sh` が全 check を見て判定する（失敗 0 件・実行中 0 件・成功 1 件以上）。
  **この集約判定に加えて、名前で success を要求する check がある**（Vercel の 2 context と、
  2026-08-26 以降は Static Checks / Unit Tests。上記 §merge gate の required checks 参照）
- **`ci.yml` の `gate` / `static` / `unit` は draft の間 skip する（2026-08-26、[#2415](https://github.com/Dayopt/dayopt/issues/2415)）。**
  guard は 3 job すべてに書く必要がある — `static` / `unit` の `if:` は `always()` を含むため、
  `gate` にだけ guard を置くと上流が skip されても下流が実行側へ倒れる。条件は `draft != true`
  （`== false` にすると `workflow_dispatch` で `pull_request` context が null になり全 job が skip
  される）。`types` の `ready_for_review` はこの skip の前提（無いと ready 化で再発火しない。PR #1810 で実測）
- **判定は `statusCheckRollup` を畳んでから行う。** rollup は同名 check を畳まないため
  （`gh pr checks` は畳む）、同一 head SHA で 2 回 run が走ると古い run の failure / cancelled が
  残り続け、再実行で解決してもマージ不能になる。畳む単位は `gh pr checks` に合わせて
  **型 + workflow 名 + check 名**（name だけで畳むと別 workflow の同名 job の failure が隠れる）。
  代表の選び方は「最新を採る」ではなく、次の優先順で決める:
  1. **実行中が 1 つでもあれば実行中**（queued な run は `startedAt` を持たないことがあり、
     単純な最新判定では実行中を見落として素通りする）
  2. **判定を持つ entry**（`success` / `failure` / `cancelled` / `timed_out`）のうち `startedAt` 最大。
     `skipped` / `neutral` / `stale` は失敗にも成功にも数えないため、これが代表になると同名の
     古い failure が消える。**古い `failure` は新しい `skipped` より優先される**
  3. どれも判定を持たなければ `startedAt` 最大

  名前を特定できない entry は畳まず全件残す。契約は
  `scripts/__tests__/finish-branch.test.ts` が固定する（#1768）

- **audit contract 変更 PR の guard failure は trusted dispatch で解除する。**
  `production-config-audit.yml` は audit contract 保護対象（`scripts/ci/production-config-audit.mjs` /
  各 `production-build-gate.mjs` / workflow 自身）を変更する PR で、`pull_request_target` の check run
  `Audit Vercel metadata (trusted)` を設計として必ず failure にする（PR code に contract 変更を
  自己検証させないため）。**2026-09-03（#2571）以降、`pull_request_target` にはこの 4 path の
  `paths` filter が付いており、そもそも contract 変更 PR でしか workflow が起動しない**
  （それ以外の PR では check run も status も存在しないので、免除の判定自体が走らない）。
  live な env drift の検出は日次 cron・`push:main`・promote 経路の `runProductionConfigAudit` が担う。
  **ただし checkpoint を `paths` だけに委ねてはいない。** workflow が起動しない条件は `paths` の
  意味論だけでなく、Actions の一時 Disable・base 側の workflow 定義の破損（`pull_request_target` は
  base 側の定義で評価される）・`paths` の書き間違い・changed files が 3,000 件を超えた時の GitHub 仕様を
  含み、いずれも「PR code に contract 変更を自己検証させない」設計を静かに無効化する。そこで
  `finish-branch.sh` は **workflow の起動有無と独立に**、contract を変えた PR へ status
  `Production Config Audit` の success を要求する（判定は `protected-path-gate.mjs` の `auditContract`）。
  **変更ファイル一覧そのものを取得できなかった PR も要求する** — contract 変更を否定できない以上、
  通す理由が無い（#2586 で Codex と architecture-guard の両系統から同じ指摘）。解除は **push ごとに** `gh workflow run production-config-audit.yml --ref <branch>`
  の trusted dispatch を実行する。成功すると commit status `Production Config Audit` が head SHA へ
  success で発行される。workflow_dispatch run の check run は PR の `statusCheckRollup` に紐づかないため
  畳み込みでは解消できず、`finish-branch.sh` は **status `Production Config Audit` が success の時に限り**
  guard check run の failure を失敗数から除外する（照合は 型 + workflow 名 + check 名 / context の完全一致のみ）。
  fail-closed: audit が本当に落ちた PR も dispatch 未実行の contract 変更 PR も status は failure のまま
  免除は発動せず、status は SHA ごとの発行なので新しい push で自動的にリセットされる。免除対象は
  guard の `conclusion: failure` だけで、`cancelled` / `timed_out`（監査が完走していない状態）は
  従来どおり停止する。**dispatch は branch 側の workflow 定義と audit script に `VERCEL_TOKEN` を
  渡して実行される**ため、contract 変更 PR の diff をレビューした後に、ユーザーの明示指示で実行する。
  契約は同じく `scripts/__tests__/finish-branch.test.ts` が固定する

段階的導入案と当時の計測値は履歴であり、現行構成として複製しない。経緯は ADR-016（削除済み、git 履歴参照） に残す。

### PR の Vercel check が詰まった時の切り分け（策定日: 2026-08-12）

`Vercel – product` / `Vercel – web` が green にならない時、**先に「deployment が存在して失敗しているか、そもそも存在しないか」を分ける。** ここを分けずにコード修正へ走ると、原因が CI 側の一過性障害でも実装を疑って時間を溶かす。2026-08-12 に実測した 2 型:

1. **branch 選択的な Vercel webhook 欠落（deployment が「存在しない」型）**: 特定 branch への push だけ Vercel 側に deployment が作られず、GitHub 上の check が pending のまま進まない。**空コミットで再 push しても直らない**（commit [`1f3e1bb58`](https://github.com/Dayopt/dayopt/commit/1f3e1bb58931258097a72ea6ef92064935e7e716) は再発火を狙った空コミットだが、根治には至らなかった。deployment 一覧に当該 commit の記録が無いことを実測確認済み）。復旧は Vercel Dashboard の **Create Deployment** で該当 branch / commit を手動指定する。**cancel された build でも status は success で付く**ため、手動 deployment を取り消しても check 自体は green のまま残る（取り消し操作と check 状態が一致しない点に注意する）
2. **turbopack ビルドキャッシュの腐敗**: build script 自体は turbopack を指定していないのに、ビルドログに turbopack path 由来の `module not found` とキャッシュ復元ログが同時に出る。これが「turbopack を使っていないはずなのに turbopack のログが出る」という不一致が診断根拠になる。復旧は `vercel redeploy`（既存 build のキャッシュを使わない再実行）

どちらも Vercel 側のビルドインフラの一過性障害で、アプリケーションコードの回帰ではない。切り分けの第一手は常に「そもそも deployment ができているか」の確認（Vercel Dashboard の Deployments 一覧）で、無ければ型 1、あるが失敗していれば型 2 を疑う。

**型 1 の復旧経路は 2 つ（2026-08-18 実測）。** Vercel の deployment policy（git-source-only）により、API / CLI で作成した deployment は `BLOCKED` 状態になり、承認して production/preview へ通す経路が無いことを実測確認した。実測済みの復旧経路は Vercel Dashboard の **Create Deployment**、および該当 branch への新しい実変更 push の 2 つ（いずれも復旧を確認済み）。空コミット push での復旧は本実測では試していない（未検証）。

**型 3（GitHub Actions 側）: `CI` / `Docs Guard` の check-suite が丸ごと存在しない。** `gh pr checks` に主要 workflow が一切現れず（`Production Config Audit` のような `pull_request_target` 系だけは走る）、commit の check-suites API を見ても対応する suite 自体が無い（実測時は `ci.yml` / `docs-guard.yml` の 2 ファイル。#2483 で docs-guard.yml は ci.yml へ統合済みのため、現在確認すべきは `ci.yml` の suite の有無のみ）（2026-08-14、PR #2083 で実測。close→reopen で `reopened` イベントの配信は確認できたが、それでも発火しなかった）。webhook 配信の失敗ではなく、**`mergeable: CONFLICTING` を疑う**のが正しい切り分け。`pull_request`（`pull_request_target` ではない）トリガーの workflow は GitHub 側で test merge commit を作れないと起動されないため、base（`main`）との conflict が解消されるまで check-suite 自体が作られない。復旧はコード修正でも再 push でもなく、`gh pr view <N> --json mergeable,mergeStateStatus` で `CONFLICTING` を確認したうえで通常の conflict 解消（`git merge origin/main` して resolve）を行うこと。

---

## DNS 管理（Cloudflare）

策定日: 2026-08-13（[#2001](https://github.com/Dayopt/dayopt/issues/2001)。2026-08-12、Search Console のドメイン検証作業中に Main が実測で発見）

`dayopt.app` は **registrar が Vercel（Vercel Registrar）、権威 DNS が Cloudflare** という分離構成になっている（`dig NS dayopt.app` は `keira.ns.cloudflare.com` / `colin.ns.cloudflare.com` を返す。移管手順は [contact-email.md §1 DNS と受信の準備](../operations/contact-email.md#1-dnsと受信の準備ユーザー作業)）。

**DNS レコードの変更は Cloudflare dashboard で行う。Vercel の Domains 画面で DNS レコードを追加しても権威側には反映されない**（2026-08-12、実際に Vercel 側へレコードを追加 → 権威側に出ないことを確認 → 削除する事象が発生した）。Vercel の Domains 画面が持つのは registrar 機能（更新・移管・nameserver 設定）だけで、DNS レコードの実体は Cloudflare zone が持つ。

この運用手順は §出口コスト台帳 の粒度（同節参照）には含めない。台帳は「捨てたら何が壊れるか」だけを持ち、日々の変更手順はここに置く。

---

## Bot 対策（Cloudflare Turnstile）

Dayopt は bot 対策として **Cloudflare Turnstile** を使う。reCAPTCHA v3 + v2 fallback から 2026-04 に乗り換え、マーケティングサイトとアプリの両方で同じ仕組みに統一した。

### 適用範囲

| 画面                | repo | 対象フロー             | 検証主体                       |
| ------------------- | ---- | ---------------------- | ------------------------------ |
| `/contact` フォーム | web  | Resendメール配送前     | 自前 siteverify POST           |
| `/signup` フォーム  | app  | `supabase.auth.signUp` | Supabase Auth (Bot Protection) |

widget は 1 つ（`agent/turnstile`）で **1 widget 複数 hostname**（`dayopt.app` / `localhost` / `*.vercel.app`）をカバーする。環境別に site-key を分けない。

### 実装レイヤー

#### app repo

```
src/lib/turnstile/
├── config.ts       # SITE_KEY + isTurnstileEnabled()
├── Turnstile.tsx   # <Turnstile> widget ラッパ
└── index.ts        # barrel
```

- `SignupForm.tsx` が `<Turnstile onSuccess={setToken}>` で token を state に保持
- `useAuthStore.signUp(email, password, { captchaToken })` で Supabase へ渡す
- Supabase が secret 検証する（app は secret を持たない）

#### web repo

```
src/lib/turnstile/
├── config.ts       # SITE_KEY + VERIFY_URL
├── verify.ts       # verifyTurnstile(token, ip)
├── Turnstile.tsx   # <Turnstile> widget ラッパ
└── index.ts        # barrel
```

- `contact-form.tsx` で widget を表示、token を state に保持
- `/api/contact/route.ts` が CSRF → content type / body / schema → IP rate limit → honeypot → **`verifyTurnstile`** → 全体rate limitの順に検証
- Turnstile 失敗時は 403 `BOT_DETECTED` を返す

### Secret 管理

Secrets 運用の正本は `docs/operations/secrets.md`。1Password が master で、Supabase Dashboard の Turnstile secret は replica として手動同期する。

#### 1Password vault

```
agent/turnstile
├── NEXT_PUBLIC_TURNSTILE_SITE_KEY
└── TURNSTILE_SECRET_KEY
```

#### env 参照

- **app** — `.op-env.agent`:
  ```
  NEXT_PUBLIC_TURNSTILE_SITE_KEY=op://agent/turnstile/NEXT_PUBLIC_TURNSTILE_SITE_KEY
  ```
  （app は secret を持たない）
- **web** — `.op-env.agent`:
  ```
  NEXT_PUBLIC_TURNSTILE_SITE_KEY=op://agent/turnstile/NEXT_PUBLIC_TURNSTILE_SITE_KEY
  TURNSTILE_SECRET_KEY=op://agent/turnstile/TURNSTILE_SECRET_KEY
  ```
- **Supabase Auth** — Dashboard → Authentication → Bot & Abuse Protection → Turnstile
  - `TURNSTILE_SECRET_KEY` を 1Password master から手動同期する
  - app の signup flow はこの dashboard 設定に依存する

### 検証フロー

#### web contact form

```
user submit
  → [client] Turnstile widget で token 取得
  → [client] POST /api/contact { ..., turnstileToken }
  → [server] CSRF 検証
  → [server] content type / 16 KiB body / strict schema
  → [server] IP rate limit
  → [server] honeypot (website field)
  → [server] verifyTurnstile(token, ip) ─ siteverify POST
      ├ success: true  → 全体rate limit → Resendメール配送
      └ success: false → 403 BOT_DETECTED
```

#### app signup

```
user submit
  → [client] Turnstile widget で token 取得
  → [client] supabase.auth.signUp({ options: { captchaToken } })
  → [Supabase] Turnstile secret で検証（dashboard 設定）
      ├ success: true  → user 作成
      └ success: false → AuthError
```

### 運用

#### Rotation

1. Cloudflare dashboard で widget の site/secret を regenerate
2. 1Password `agent/turnstile` の fields を更新
3. Supabase Auth dashboard の secret key を差し替え
4. アプリ再デプロイは**不要**（op 経由で次回起動時に新値が注入される）

#### 開発時フォールバック

Cloudflare 公式の dev 用テストキーを使う場合でも、repo docs や `.op-env.agent.example` には literal 値を書かない。必要な値は Cloudflare docs で確認し、一時作業後は `.op-env.agent` を `op://` 参照へ戻す。

### 移行経緯

#### 旧実装（〜 2026-04）

- `src/lib/recaptcha/`（config / verify / hooks / RecaptchaScript）
- `/api/auth` route に v3 score 検証コード
- `RECAPTCHA_SECRET_KEY_V3` / `V2`、`NEXT_PUBLIC_RECAPTCHA_SITE_KEY_V3` / `V2`

#### 課題

- auth route の v3 検証は **dead code**（caller が `recaptchaToken` を送っていなかった）
- Google トラッキング依存、v2 challenge の UX 摩擦
- スコア閾値（MODERATE=0.5）の運用判断が難しい

#### 置換後（2026-04〜）

- `src/lib/recaptcha/` 削除
- Supabase Auth 公式の `options.captchaToken` 連携に切替 → dead code 解消
- score 判定不要（Turnstile は success boolean のみ）
- reCAPTCHA 4 env key 削除、Turnstile 1 env key（app）/ 2 env key（web）に簡素化

### 関連ファイル

- `src/lib/turnstile/`（app / web 両方）
- `src/features/auth/components/SignupForm.tsx`（app）
- `src/features/auth/stores/useAuthStore.ts`（app、`captchaToken` option 追加）
- `src/app/api/auth/route.ts`（app、reCAPTCHA 分岐削除。この route 自体は #1942 で削除済み）
- `src/app/[locale]/(auth)/client-layout.tsx`（app、`RecaptchaScript` 削除）
- `src/app/[locale]/(marketing)/contact/contact-form.tsx`（web）
- `src/app/api/contact/route.ts`（web、`verifyTurnstile` 挿入）
- `src/platform/config/env.ts`（web、env 追加）
- `src/env.ts`（app、env 置換）
- `.op-env.agent.example`（app / web 両方の参照例）
- `agent/turnstile` item（1Password）

### 今後の拡張余地

- **app の API route 化**: signup / signin は client-side Supabase 直呼び。将来 server-side で追加の anti-abuse（IP 評価、メールドメイン検査など）を挟むなら、その時点で route と rate limiter を新設する。かつて存在した `/api/auth` route は呼び出し元ゼロの攻撃面だったため #1942 で削除済みで、再利用できる残骸は無い
- **Turnstile analytics 活用**: Cloudflare dashboard の challenge 通過率 / 失敗率を週次で確認する運用を確立する
- **ログイン flow への適用**: ブルートフォース対策として login にも Turnstile を追加する余地あり（現状は rate limit のみ）

---

## API Endpoints Overview

Product / Webの`src/app/api/**`配下にある主要REST / Webhook endpoint総覧。tRPC procedureは`/api/trpc/[procedure-path]`に集約され、procedure単位の仕様は各featureの`server/router.ts`を参照すること。

策定日: 2026-04-26。下記 §一覧 と実装 route の双方向照合は `scripts/__tests__/infra-api-routes-contract.test.ts` が機械的に固定する（[#1981](https://github.com/Dayopt/dayopt/issues/1981)。route の追加・削除と表の更新漏れの両方で fail する）。人手の「最終照合」日付には依存しない。

### 一覧

| App     | Path                                         | Method               | 認証                               | Rate Limit                      | Runtime                  | 副作用 / 説明                                                                                                              |
| ------- | -------------------------------------------- | -------------------- | ---------------------------------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Product | `/api/health`                                | GET                  | なし                               | なし                            | nodejs                   | DB / Upstash Redisの疎通をcheckし`healthy / degraded / unhealthy`を返す。Productionは`{ status }`だけを公開                |
| Product | `/api/health/version`                        | GET                  | なし                               | なし                            | nodejs                   | ビルドの`{ version, commitSha }`をno-storeで返す（外部I/Oなし）。開いたままのタブの新deploy検知に使う                      |
| Product | `/api/csp-report`                            | POST                 | なし                               | IP 20/分 + 全体120/分           | nodejs                   | Product originの16 KiB以下のCSP reportだけを検証し、URL queryを除去してSentryへ送信                                        |
| Product | `/api/trpc/[trpc]`                           | GET / POST           | procedure依存                      | procedure依存                   | nodejs                   | tRPC procedureのルーティング本体。Contactは認証済み`contact.submit`を使う                                                  |
| Product | `/api/oauth/token`                           | POST                 | OAuth client（PKCE）               | IP 10/分 + 全体120/分           | nodejs                   | MCP client向けにaccess / refresh tokenを発行・回転する（`authorization_code` / `refresh_token`）。公開pathは`/oauth/token` |
| Product | `/api/mcp`                                   | GET / POST / DELETE  | Bearer access token                | 認証前IP 1,200/分 + user 120/分 | nodejs                   | MCP Streamable HTTP transport本体。公開pathは`/mcp`と`mcp.dayopt.app`                                                      |
| Product | `/api/v1/calendar/[token]`                   | GET                  | token (URL)                        | `icalFeedRateLimit`             | nodejs                   | Service Roleで対象userのplansをiCalendar形式へ変換                                                                         |
| Product | `/api/integrations/google-calendar/start`    | GET                  | Supabase Auth (Cookie) + Proゲート | user 10/時                      | nodejs                   | Google OAuth同意画面へのredirectを組み立て、state / verifierをcookieへ置く                                                 |
| Product | `/api/integrations/google-calendar/callback` | GET                  | Supabase Auth (Cookie) + Proゲート | user 10/時（startと同一key）    | nodejs                   | 認可codeをtokenへ交換し接続を保存する。startを踏まずに到達できるためProゲートとstate照合をここでも通す                     |
| Product | `/api/cron/calendar-sync`                    | GET                  | `CRON_SECRET` (Bearer)             | なし                            | nodejs (maxDuration 60s) | Vercel cronが15分毎に叩く。dueな接続を時間予算（50秒）内で同期する                                                         |
| Product | `/api/cron/external-connection-maintenance`  | GET                  | `CRON_SECRET` (Bearer)             | なし                            | nodejs (maxDuration 60s) | Vercel cronが15分毎に叩く。失効・revoke待ちの外部接続を掃く                                                                |
| Product | `/api/cron/calendar-account-deletion-settle` | GET                  | `CRON_SECRET` (Bearer)             | なし                            | nodejs (maxDuration 60s) | Vercel cronが毎時叩く。account_delete種別のpending intentをsettleする                                                      |
| Product | `/api/cron/billing-reconciliation`           | GET                  | `CRON_SECRET` (Bearer)             | なし                            | nodejs (maxDuration 60s) | Vercel cronが日次で叩く。Stripeの直近イベントとdurable webhook stateを照合し、差分を検出する                               |
| Product | `/api/v1/system/*`                           | GET / POST / OPTIONS | なし                               | なし                            | nodejs                   | 廃止済みsystem APIを常に404にするretirement boundary（Web側と同型）                                                        |
| Product | `/api/webhooks/resend`                       | POST                 | Product Resend signature           | Redis processing lease          | nodejs (maxDuration 30s) | Product contact failureをPIIなしでSentryへ通知し、既存transactional mailのbounce / complaint suppressionも維持             |
| Product | `/api/webhooks/stripe`                       | POST                 | Stripe signature                   | なし                            | nodejs (maxDuration 30s) | subscription stateを反映しtransactional emailを送る                                                                        |
| Web     | `/api/compass-docs`                          | GET                  | なし                               | なし                            | nodejs (maxDuration 30s) | Compass内の公開ドキュメントを検索                                                                                          |
| Web     | `/api/contact`                               | POST                 | CSRF + Turnstile                   | IP + Web全体                    | nodejs (maxDuration 30s) | 16 KiB以下のstrict inputをProduction限定でResendへ配送。成功形式は`{ success: true }`                                      |
| Web     | `/api/csp-report`                            | POST                 | なし                               | IP + Web全体                    | nodejs (maxDuration 30s) | Web originのCSP reportを検証・正規化してSentryへ送信                                                                       |
| Web     | `/api/search`                                | GET                  | なし                               | IP                              | nodejs (maxDuration 30s) | build済み検索indexをlocale別に検索                                                                                         |
| Web     | `/api/og`                                    | GET                  | なし                               | なし                            | edge (maxDuration 25s)   | SNS向けOG画像を動的生成                                                                                                    |
| Web     | `/api/v1/system/*`                           | GET / POST / OPTIONS | なし                               | なし                            | nodejs (maxDuration 5s)  | 廃止済みsystem APIを常に404にするretirement boundary                                                                       |
| Web     | `/api/webhooks/resend`                       | POST                 | Web Resend signature               | Redis processing lease          | nodejs (maxDuration 15s) | Web contact failureだけをsource tagで所有判定し、PIIなしでSentryへ通知                                                     |

### 共通方針

- **Runtime**: Product endpoint と Web の通常routeは`nodejs`。Web `/api/og`だけは画像生成用の`edge` runtime
- **Timeout**: product / web とも**各 route の静的 `maxDuration` が正本**で、`vercel.json` の functions glob は使わない。契約は `apps/{product,web}/src/app/route-duration-contract.test.ts` が固定する（詳細は下記 §Function 実行時間の上限）
- **エラーログ**: `@/lib/logger` で構造化ログ。webhook / 認証のうち予期しない障害だけをSentryへ一度送信し、認証失敗などの想定内レスポンスはIssue化しない
- **入力バリデーション**: Zod (`@/lib/zod`) を全ハンドラで使用
- **Supabase アクセス**: Productの一般endpointは`@/lib/supabase/server`の`createClient`（Cookieベース、RLS適用）。DB書込が必要なProduct webhookとiCal feedだけ`createServiceRoleClient`を使う。Web contact webhookはDBへ書かない
- **REST 維持の理由**: tRPC を主軸としつつ、以下は REST のままにする:
  - `/api/health`: 単純な GET、外部監視ツール対応
  - `/api/csp-report`: ブラウザが直接 POST する CSP report-uri
  - `/api/v1/calendar/[token]`: 外部カレンダーアプリが直接 GET、tRPC 形式不可
  - `/api/mcp` / `/api/oauth/token`: MCP と OAuth 2.0 の外部プロトコルで、リクエスト形式が仕様側で決まっている
  - `/api/cron/*`: Vercel cron が `Authorization: Bearer $CRON_SECRET` 付きの GET で叩く
  - `/api/integrations/*`: 外部 IdP との redirect flow。302 と cookie を返す必要があり、呼び出し元がブラウザのナビゲーション
  - Web `/api/contact`: 未認証のmarketing siteから送る公開formであり、CSRF / Turnstile / body上限をroute境界で扱う
  - `/api/webhooks/*`: 外部サービスが直接 POST、レスポンス形式が tRPC と合わない

### Function 実行時間の上限

策定日: 2026-08-12（#1701 Phase 2）

**正本は各 route の静的 `export const maxDuration`。** `vercel.json` の `functions` glob と Dashboard の Default Function Timeout はどちらも正本にしない。契約は `apps/product/src/app/route-duration-contract.test.ts` と `apps/web/src/app/route-duration-contract.test.ts` が固定する（allowlist 方式なので、**契約表に無い route を足すと test が落ちる**）。

#### 値は内側 timeout から導出する

`maxDuration` は「速そうだから短く」ではなく、**その route が呼ぶ外部 I/O の timeout の worst path より大きく**取る。下回ると handler が自前のエラー応答を返す前に kill され、**graceful failure（4xx/5xx の JSON）が Vercel の 504 に化ける**。既存の cron が `maxDuration 60` に対して内部予算 `TIME_BUDGET_MS = 50_000` を持つのと同じ規律。

| 内側 timeout                            | 値         | 場所                                                               |
| --------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Supabase server / OAuth client の fetch | 15s        | `lib/supabase/server.ts` / `lib/supabase/oauth.ts`                 |
| OAuth 用 service-role client の fetch   | 15s        | `lib/oauth-server/db.ts` の `OAUTH_DB_TIMEOUT_MS`                  |
| Google token / API 呼び出し             | 15s        | `external-calendar/server/google-oauth.ts` / `providers/google.ts` |
| Rate limit（Upstash）                   | 2s         | `lib/rate-limit/upstash.ts`                                        |
| Health の DB check                      | 5s ×2 逐次 | `api/health/route.ts`                                              |
| Health の Redis check                   | 5s         | `api/health/route.ts` の `REDIS_CHECK_TIMEOUT_MS`（#1967）         |

段は 4 つに畳む。段を増やすと drift 保守が増えるだけで、上限の役目は blast radius の固定であって最適化ではない。

| 段  | 条件                | 値                                                |
| --- | ------------------- | ------------------------------------------------- |
| A   | 外部 I/O 無し       | 5–15                                              |
| B   | 外部 I/O 1–2 本     | 30                                                |
| C   | 外部 I/O が複数逐次 | 60                                                |
| D   | 構造的に上限が無い  | 300（理由と解除 issue を route のコメントに書く） |

product の contract test は「外部 I/O をする route は **Supabase 1 往復 + rate limit 1 回**（現状 17s）を必ず上回る」という不等式も検査する。内側 timeout を後から伸ばした変更が route を黙って kill 側へ倒すのを、ここで落とす。

**Supabase client は 3 種類あり、不等式チェックが読むのは `lib/supabase/server.ts` の 1 つだけ。** 別の client を使う route は、その client に上限があるかを個別に確認する。実際 `lib/oauth-server/db.ts` は上限を持っておらず、`/api/oauth/token` を 60 秒にした時点では**内側が無制限のまま route 側だけ縮んでいた**（2026-08-12、外部レビュー P2 で検出。同 commit で `OAUTH_DB_TIMEOUT_MS` を追加して解消）。

この経路が特に危ないのは、token endpoint が消費する grant が **1 回しか使えない**ため。「サーバー側では成功したがレスポンスが返らない」状態を作ると、client は再試行しても使用済みエラーで詰む。**内側で先に切って正規の OAuth エラーを返す**方が回復可能で、これが「内側 timeout を先に発火させる」規律の実利。

**ただし test が保証するのは下限であって worst path ではない。** 依存が全部同時にそれぞれの timeout まで張り付くケースは、`api/trpc/[trpc]` のように dispatch 数へ上限が無い route では原理的にカバーできない。そこまでカバーする値へ引き上げると 300 に近づき、**障害半径を絞るという目的そのものを失う**。**「test が通る＝安全」と読まないこと。** 新規 route では worst path を自分で数える。

#### 例外を作る基準は「失敗の質」

とはいえ **全部を「上限は保証ではない」で流してよいわけではない**。逐次 worst path が段を超える route のうち、**失敗が不可逆なもの**は段から外して値を上げる。

| route                                       | 逐次 worst path                        | 値      | 失敗したら何が起きるか                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/integrations/google-calendar/callback` | 80s（消費前スラック 35s + budget 45s） | **90**  | Google の authorization code は token 交換で消費される。その後の DB 書き込み中に kill されると、接続は保存されないまま code だけ使用済みになり、再試行は `invalid_grant`。**ユーザーは認可からやり直し** |
| `api/mcp` / `mcp`                           | 認証だけで 75s（15s × 5 逐次）         | **120** | 認証を通り切る前に kill され、handler が返すはずの 503 すら出せず**全 tool 呼び出しが 504**                                                                                                              |

判断基準は「504 で済むか、ユーザーが取り返せない状態になるか」。前者なら段どおりでよく、後者なら値を上げる。2026-08-12 に外部レビューが 3 ラウンドかけてこの 2 件を指摘し、当初 60 に置いていたのを訂正した。

**「値を上げるのは暫定対応」から始まったが、callback は確定した設計になった。** #1990（PR #2075 に統合）で「不可逆な操作（code 消費）を始める前に残り予算を検査する」設計を callback に入れ、`POST_EXCHANGE_BUDGET_MS = 45_000` 固定の budget check を追加した。当初の想定は maxDuration を 60 へ戻せるというものだったが、budget check の固定予算設計により code 消費前フェーズ（getUser / MFA / rate limit / write fence / Pro 判定の直列 4〜5 ホップ）の予算が `TIME_BUDGET_MS(50s) - POST_EXCHANGE_BUDGET_MS(45s) = 5s` しか残らず、軽微な遅延だけで従来成功していた接続が `budget_exhausted` になる可用性の崖ができていた。2026-08-14、PR #2075 クロスレビューでこれを検出し、**`maxDuration` を 90 へ引き上げて解消した**（`POST_EXCHANGE_BUDGET_MS` は不変、消費前スラック 35s に回復、worst case 総計 80s ≤ 90 で hard kill margin 10s を維持。安全性 = code 消費前後の境界の扱いは変えず、可用性の崖だけを除去した）。60 への到達は見送り、90 が現在の確定値。

#### `/api/health` を 30 にしたことの監視上の含意

UptimeRobot は 5 分間隔の HTTP status 監視で、**503 も 504 も同じく DOWN 扱い**なので alert の発火条件は変わらない。`checkRedis` の `redis.ping()` は #1967（2026-08-13）で `AbortSignal.timeout(REDIS_CHECK_TIMEOUT_MS = 5_000)` を fetch レイヤの signal として渡すようになり、Upstash が無応答でも 5 秒で abort して `logger.error('[health] dependency check failed', ...)` + 503 を返す。maxDuration 30 秒まで張り付いて 504 になる窓は閉じた。

alert policy の文言は「`/api/health` が 503 を返す」なので、504 が出た場合も unhealthy と読む（原因不明の 504 が出たら `checkRedis` 以外の予期しない hang を疑う）。

#### tRPC が 60 の理由（旧 300 から #1965 で引き下げ）

`/api/trpc/[trpc]` は**全 procedure を 1 function で捌く**ため、最長 procedure に律速される。300 秒だった当時は `externalCalendar` の `syncNow` / `updateSelectedCalendars` が呼ぶ `syncConnection` が wall-clock 予算を持たず（deadline は接続と接続の「間」でしか判定されなかった）、これが 300 に張り付かせていた唯一の既知の理由だった。2026-08-14、PR #2075 で `syncConnection` に wall-clock 予算を持たせ、`router.ts` が `deadlineAt` を渡すようになったため **`maxDuration` を 60 へ引き下げた**（`apps/product/src/app/api/trpc/[trpc]/route.ts`）。

#### Dashboard の Default Function Timeout（実施済み・pin 済み）

route handler の契約表に載らない経路（dynamic page の SSR、Server Action、ISR 再生成、将来追加される route）は project の Default Function Timeout を継承する。2026-08-12 実測で **product / web とも 300 秒**だったところを、同日 User が Dashboard で 60 秒へ flip した。2026-08-14、product / web とも Dashboard Functions タブの Default Max Duration = 60 を目視再確認済み。

flip 前に検討したチェック項目。**証拠が残っていない項目は「未取得」と明記する**（2026-08-14 内製クロスレビューで、証拠の無い項目を「満たしていた」と書いていた点を指摘され訂正）:

1. **未取得。** Vercel Observability で直近 30 日の route 別 p99 duration を見て 60 秒超がゼロであることを確認する想定だったが、確認した証跡が残っていない。repo の静的解析では「実際に長い経路」は分からないため、次に同種の flip を検討する際はこの確認を先に行う
2. **product と web を別々に判断する。** web には ISR（`revalidate = 3600` の RSS feed）があり、再生成 function は route handler の契約表に載らない
3. **flip 実施時点（2026-08-12）では `/api/trpc/[trpc]` が project 既定を上回る 300 秒の明示値を持ち、project 既定を上書きする形で運用されていた。** 2026-08-14、PR #2075（#1965 の wall-clock 予算実装）により `/api/trpc/[trpc]` の `maxDuration` は 60 へ引き下げられた（詳細は上記 §tRPC が 60 の理由）。現時点で project 既定 60 を上回る静的宣言を持つ route は `api/integrations/google-calendar/callback`（90）と `api/mcp` / `mcp`（120）の 2 つのみで、いずれも project 既定を明示的に上書きする設計（上記 §例外を作る基準は「失敗の質」参照）。**runtime 適用の実測（宣言どおり Vercel が適用しているか）は未取得**（下記 §「実際に適用された」ことの証拠 参照。Vercel の deployment API は per-function `maxDuration` を返さないため自動検証はできない）
4. rollback: Dashboard で 300 へ戻し、再 deploy して反映（`[hours]`）。**戻す場合は同一対応で下記 pin の契約値（`PROJECT_METADATA_CONTRACTS` の `functionDefaultTimeout`）も 300 へ戻すこと** — 戻さないと Production Config Audit が failure になり、この rollback を含む hotfix の出荷経路まで全 merge が止まる

flip 忘れ・後日の戻しを検知する仕組みは **#1966** で `production-config-audit.mjs` へ `functionDefaultTimeout` を pin 済み（`scripts/ci/production-config-audit.mjs` の `auditProjectSettings`）。フィールドは `GetProjectResponseBody` のトップレベルではなく **`resourceConfig.functionDefaultTimeout`**（`vercel/sdk` の型定義で確認、2026-08-14）。値が 60 以外、または `resourceConfig` に当該キーが無ければ fail closed で audit が failure になる。**このフィールドパスは `vercel/sdk` の型定義と Dashboard 目視だけが根拠で、`GET /v9/projects/{idOrName}` の実応答での存在は未確認。** この repo には「スキーマに載っているが実応答に無い」前例がある（`enableAffectedProjectsDeployments`、2026-08-05）。唯一の実測は merge シーケンスの trusted dispatch — dispatch が `missing from project metadata` で落ちたら、そのまま fix を重ねず `defaultResourceConfig` 等の別フィールドパスを確認してから修正する。

#### 「実際に適用された」ことの証拠

**Vercel の deployment API は per-function の `maxDuration` を返さない**（実測: `GET /v13/deployments/{id}` → `functions: null` / `lambdas[].maxDuration: null`）。API 経由の自動検証はできないので、証拠は次の順で取る:

1. contract test — 宣言が存在し値が契約どおりであること（build が宣言を尊重したかは証明しない）
2. Vercel Dashboard の Functions タブ — Preview で目視
3. build 成果物（未実装）— Next.js 16 は `functions-config-manifest.json` を出力する。`apps/product` は Vercel build で既に `verify:bundle` を走らせているので、ここに assertion を足せば毎 build で機械検証できる。manifest の正確な path と shape を確認してから入れる

### 変更ガイドライン

- 新規 endpoint を追加する前に、tRPC procedure で済まないか検討する（`features/*/server/router.ts`）
- **新規 route handler を追加したら、`route-duration-contract.test.ts` の契約表に 1 行足す**（足さないと test が落ちる）
- **endpoint を追加・削除したら、上記 §一覧 の表も同じ PR で更新する**（`infra-api-routes-contract.test.ts` が表と実装 route の食い違いを検出して test を落とす）
- REST 維持の理由に該当しない場合は tRPC を採用
- 認証必須の endpoint は Supabase server client + Cookie で `getUser()` 検証、または webhook signature 検証
- 公開requestのrate limit identifierは保存前に不可逆化する。Contact / CSPはbackend unavailable時にfail-closed、既存tRPC / iCalは定義済みfallbackを維持する
- rate limitのIP identifierはVercelが上書きする`X-Real-IP`だけを検証し、`X-Forwarded-For`を解析しない。欠落・不正値は共有`ip:unknown`に入れてfail closedにする。この前提はVercel単独topologyに依存する
- **認証操作にapp側のrate limit層は無い**。かつて`/api/auth`が持っていたが、呼び出し元ゼロの攻撃面だったため#1942で削除した。現在はSupabase Auth のproject-level rate limitだけが担う（期待値は`scripts/ci/production-auth-config-audit.mjs`がpinする）。server側のanti-abuseが要るなら、その時点でrouteとlimiterを新設する
- 副作用はloggerで技術状態だけを追跡し、問い合わせ本文・氏名・email・raw webhook bodyを記録しない

### 関連ドキュメント

- tRPC procedure 設計: `.agents/skills/trpc-router-creating/SKILL.md`（`trpc-router-creating` skill）
- Supabase Branching 運用: `.agents/skills/supabase/SKILL.md`（`supabase` skill）
- 問い合わせメール運用: `docs/operations/contact-email.md`

---

## Supabase 型自動生成

Supabase CLIを使用して、データベーススキーマからTypeScript型定義を自動生成する。

### コマンド

| コマンド                            | ソース          | 用途                                      |
| ----------------------------------- | --------------- | ----------------------------------------- |
| `npm run types:generate`            | production main | `types:generate:production` の互換 alias  |
| `npm run types:generate:production` | production main | production main から生成                  |
| `npm run types:generate:local`      | Local DB        | ローカルから生成（`supabase start` 必要） |

PR Preview Branch の schema は Supabase integration check で検証する。型生成は production main か local のどちらかを明示して行う。

全コマンドとも `apps/product/src/lib/database/generated/database.types.ts` に出力。

### 使用タイミング

#### 必須

- データベーススキーマを変更した後
- 新しいテーブルを追加した後
- カラムの型を変更した後

#### 推奨

- 定期的（週1回程度）
- 本番環境のスキーマと同期を確認する

### ワークフロー

```bash
# 1. マイグレーション作成
npm run migration:create add_new_table
# マイグレーションファイルを編集

# 2. ローカルで適用確認
npm run db:reset

# 3. 型を再生成
npm run types:generate:local

# 4. 型チェック
npm run typecheck

# 5. コミット
git add apps/product/src/lib/database/generated/database.types.ts
git commit -m "chore(types): supabase型定義を更新"
```

### カスタム型

`apps/product/src/lib/database/generated/database.types.ts` は自動生成ファイル。**直接編集禁止**。

カスタム型が必要な場合は別ファイルに定義:

```typescript
// apps/product/src/lib/database/types.ts
import type { Database } from './generated/database.types';

export type PlanRow = Database['public']['Tables']['plans']['Row'];
export type TagRow = Database['public']['Tables']['tags']['Row'];
```

### トラブルシューティング

| エラー                 | 対処                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `project_id not found` | Supabase プロジェクトの存在を確認                                                            |
| `connection refused`   | ローカル: `supabase start` を実行 / リモート: ネットワーク確認                               |
| 生成された型がおかしい | production main か local のどちらから生成したか確認。local は `supabase db reset` でリセット |

---

## App Routes Overview

Next.js App Router の**構造の決まり**を書く。実在する route の一覧は生成物を見る（この doc に書くと必ず古くなる。2026-09-16 に `/day` `/week` `playground/` など存在しない route の表を撤去した）。

| 知りたいこと                        | 見る場所                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| 画面（page）の一覧                  | [`data/architecture-inventory.md`](./data/architecture-inventory.md) の route |
| route handler の一覧（method 付き） | [`data/system-surface.md`](./data/system-surface.md) の HTTP route            |
| 画面ごとの E2E 被覆                 | [`data/system-surface.md`](./data/system-surface.md) の E2E spec → route      |

### Route Group の役割

| Group                | 置くもの                                  | 前提                                                                   |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `[locale]/(app)/`    | 認証必須の画面                            | `layout.tsx` が Providers（tRPC / Query / Theme 等）と shell を注入    |
| `(app)/(workspace)/` | 日々使う作業画面                          | `_composition/` の client ツリーを `page.tsx` から薄く呼ぶ             |
| `[locale]/(auth)/`   | 認証フロー                                | `PublicProviders`（Theme + Tooltip）だけ。データ層を持たない           |
| `src/app/` 直下      | locale を持たない route と metadata route | root layout / error / sitemap / OG image / `/maintenance` / `/offline` |

### Auth 境界

- auth check は **proxy（`src/proxy.ts`）に一元化**する。page / layout 単位の auth ガードは置かない
- 認証が要る画面は `(app)` 配下に置けばよい。認証をスキップする画面は `(auth)` 配下に置く
- 認証済みで `(auth)` を踏むのが正常系の path は除外する（`isAuthPathAllowedWhileAuthenticated`、`src/lib/auth/domain/access-policy.ts`）。`/auth/mfa-verify`、`/auth/confirm`、`/auth/callback`、`/auth/reset-password` が対象

### composition layer

各 mode の `_composition/` は「ページから見た合成 hub」。入力は `params` / `searchParams` / prefetch 済みデータ、合成対象は feature barrel、出力は 1 つの client component ツリー。`page.tsx` は prefetch と合成の呼び出しだけに保ち、view の差し替えは composition layer 内で完結させる。

### providers / shell / overlays

| Path                | 責務                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `(app)/_providers/` | データ層（tRPC / TanStack Query / Auth Store / Theme など）の合成          |
| `(app)/_shell/`     | sidebar + header + main の UI shell                                        |
| `(app)/_overlays/`  | グローバルダイアログと keyboard shortcut の global listener を集約マウント |

Provider の実際の入れ子は `ProvidersComposition.tsx` を読む（順序は副作用の依存で決まるため、ここに写さない）。

### 落ちた時にどこへ行くか

```
未認証 → (auth)            : login / signup / reset / mfa
認証済み → (app)
locale 不正 / path 不在    → [locale]/error.tsx, not-found.tsx, root not-found.tsx
致命エラー                 → global-error.tsx
オフライン (PWA)           → /offline
メンテナンス時             → /maintenance
```

### 関連ドキュメント

- Feature 境界: [AGENTS.md](../../AGENTS.md)、実際の依存は [architecture.md](./architecture.md) の生成ブロック

---

## パフォーマンス監視の原則

> **平均は見ない。p95だけを見る。**

### なぜp95か

- ユーザー体験は「一部の遅い人」で評価される
- BtoCでは「たまに遅い」が致命傷
- 平均値は問題を隠す

| 指標    | 役割                       |
| ------- | -------------------------- |
| **p95** | 体感品質・改善対象         |
| **p99** | 障害・事故の早期検知       |
| 平均    | 参考値（判断には使わない） |

### 速度指標

#### フロント（最優先）

ユーザーが「遅い」と感じる正体。

| 指標    | 意味                         | 基準（p95） |
| ------- | ---------------------------- | ----------- |
| **LCP** | 画面が表示されたと感じるまで | ≤ 2.5s      |
| **INP** | 操作に反応するまで           | ≤ 200ms     |
| **CLS** | レイアウトのズレ             | < 0.1       |

#### API

| 指標        | 基準（p95）  |
| ----------- | ------------ |
| API latency | ≤ 300ms      |
| 初期表示API | 最優先で監視 |

#### DB

| 指標           | 基準（p95） |
| -------------- | ----------- |
| クエリ実行時間 | ≤ 100ms     |

### 安定性指標

安定性 = 「失敗しても安心できること」

| 指標               | 基準          |
| ------------------ | ------------- |
| 主要導線エラー率   | < 0.1%        |
| タイムアウト率     | p95/p99で監視 |
| 同一エラーの再発率 | 月次チェック  |

**注意**: 全体エラー率ではなく、ログイン後・保存・課金など"致命導線"だけを見る。

### 最小SLO（目標値）

| 項目                     | 目標              |
| ------------------------ | ----------------- |
| ログイン後トップ LCP p95 | ≤ 3.0s            |
| 主要API latency p95      | ≤ 300ms           |
| 主要導線エラー率         | < 0.1%（増加NG）  |
| p95悪化時                | **改善Issue必須** |

### 行動ルール

数字は「合否」ではなく「行動トリガー」。

| 状況      | アクション             |
| --------- | ---------------------- |
| p95が悪化 | 改善Issueを必ず1つ作る |
| p95が良化 | 正解パターンとして記録 |

#### やってはいけないこと

- 数字だけ下げて満足
- 体感が変わらない最適化
- 最大値（p100）を追いかける

### React最適化クイックリファレンス

| パターン      | 使うとき             |
| ------------- | -------------------- |
| `useMemo`     | 高コストな計算       |
| `useCallback` | 子に渡すコールバック |
| `React.memo`  | 重いコンポーネント   |

**最適化が不要なケース**:

- 単純なコンポーネント（メモ化のオーバーヘッドの方が大きい）
- propsが毎回変わる場合
- 再レンダリングが問題になっていない場合

監視・計測の運用は `docs/operations/monitoring.md` を参照。

Next.js のビルド時最適化（PPR、prefetch、bundle 最適化等）は [`conventions-frontend.md`](./conventions-frontend.md) の「Next.js パフォーマンス最適化」セクションを参照。

### Sentry trace と Supabase logs の相関（#2728）

Supabase 宛の request に W3C `traceparent` を付け、Sentry の trace と Supabase の API Gateway / Edge Function logs を同じ `trace_id` で突き合わせる。

**3 点が揃って初めて header が付く。1 つでも欠けると silent に no-op になる**（supabase-js は warn を 1 度出すだけで、request 自体は成功する）。

| #   | 場所                                               | 内容                                                                                                                                                         |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `apps/product/src/instrumentation.ts` の Node 分岐 | `import '@supabase/supabase-js/tracing'`。OpenTelemetry の trace context extractor を `globalThis` へ登録する                                                |
| 2   | `apps/product/sentry.server.config.ts`             | `propagateTraceparent: true`。**SDK の既定は `false`** で `sentry-trace` / `baggage` しか書かず、supabase-js は「非 W3C propagator」として header を付けない |
| 3   | 各 Supabase client factory                         | `tracePropagation: SUPABASE_TRACE_PROPAGATION`（`apps/product/src/lib/supabase/trace-propagation.ts`）                                                       |

**Node runtime だけが対象**。経路ごとの可否は SDK の実装で決まっていて、設定では変えられない。

| runtime                                               | 伝播   | 理由                                                                               |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| Node（Route Handler / RSC / tRPC / cron）             | する   | `@sentry/node` が `propagation.setGlobalPropagator(new SentryPropagator())` を呼ぶ |
| Edge（`src/proxy.ts` → `lib/supabase/middleware.ts`） | しない | `@sentry/vercel-edge` は `@opentelemetry/api` を持たない                           |
| Browser（`lib/supabase/client.ts`）                   | しない | `@sentry/browser` は `@opentelemetry/api` を使わない                               |

browser を将来カバーするなら、Sentry browser 側の `tracePropagationTargets` に Supabase origin を足して `propagateTraceparent` を有効化する別経路になる（全 outgoing fetch と CORS への影響を伴う）。

**触る時の注意**:

- 新しい client factory を足したら `apps/product/src/lib/supabase/trace-propagation-wiring.test.ts` の分類へ追加する。列挙漏れは同 test が落とす
- 伝播先は supabase-js が Supabase の origin に限定する。第三者へ header は出ない
- `respectSamplingDecision` は既定の `true` のまま。未 sample の trace にも `traceparent` だけが付き、`tracestate` / `baggage` は落ちる（相関には十分なので、相関のために sampling は上げない）
- `sendOperationData` 等の追加収集は有効化しない（PII 最小化の維持）

---

## 開発コマンド一覧

Dayoptプロジェクトで使用可能な全npmコマンドのリファレンス。

### 基本開発コマンド（頻出）

```bash
pnpm dev                    # 1Password 経由で開発サーバー起動
npm run typecheck           # 型チェック
npm run lint                # コード品質チェック
npm run lint:boundaries     # feature境界チェック
npm run test:run            # ユニットテスト実行
npm run check               # typecheck + lint + test:run（一括）
```

> **Secrets**: 実値は `.env.local` に置かず、1Password master と `.op-env.agent` の `op://` 参照を `pnpm dev` で注入する。`pnpm dev` の Supabase 接続先は local 固定。素の起動が必要な一時作業だけ `pnpm dev:raw` を使う。詳細は `docs/operations/secrets.md`。
> 開発サーバー（`pnpm dev`, `npm run storybook`）の起動・停止はユーザー責務。

### 全コマンド一覧

**一覧はここに置かない**。`package.json` の `scripts` が正本で、写すと必ず古くなる（2026-09-16 に、存在しない 12 script を並べた表を撤去した）。

```bash
# root の script 名を引く
node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"

# workspace 個別（product / web / storybook / packages）
pnpm --filter @dayopt/product run
```

script の追加・改名は permission allowlist と docs 参照の同時更新まで含めて 1 変更にする（AGENTS.md の Non-Negotiables）。どのコマンドをいつ使うかは、テストは [testing.md](./testing.md)、DB は [supabase skill](../../.agents/skills/supabase/SKILL.md)、release は [releasing skill](../../.agents/skills/releasing/SKILL.md) を見る。

### pre-commit フック（自動実行）

コミット時に以下が自動で実行される:

1. **lint-staged**: ステージされた `.ts/.tsx/.js/.jsx/.mjs/.cjs` に prettier（app 配下なら eslint も）、`.json/.md/.yml/.yaml/.css/.mdx` に prettier
2. **typecheck**: `.ts/.tsx` ファイルが含まれる場合のみ `tsc --noEmit`
3. **license:check**: `package.json` 変更時のみライセンスチェック

---

## マイグレーション & リリース チェックリスト

### 運用モデル

Dayopt の標準ルートは `local → PR Preview → production`。

- **Supabase project**: `dayopt`
- **Project ref**: `yvglwblxrnrenfifsnje`
- **Local**: `supabase start` と `pnpm dev` (`op run`) を使う
- **PR Preview**: PR ごとの Supabase Preview Branch と Vercel Preview を使う
- **Production**: `main` merge 後だけ Supabase main と Vercel Production に反映する

| 環境           | Supabase                          | Vercel                         | 用途                         |
| -------------- | --------------------------------- | ------------------------------ | ---------------------------- |
| **Local**      | `supabase start`                  | `pnpm dev`                     | 手元の開発                   |
| **PR Preview** | PR ごとの Supabase Preview Branch | Vercel Preview URL (`product`) | migration / 機能の本番前検証 |
| **Production** | `dayopt` main                     | Production deployment          | 実ユーザー                   |

persistent staging は標準ルートでは使わない。固定 URL が必要な Stripe / OAuth / closed beta 検証が発生した時だけ、Vercel staging と Supabase persistent branch を追加する。

### Integration Setup

Supabase Dashboard で `dayopt` project に GitHub integration を接続する。

- Repository: `Dayopt/dayopt`
- Working directory: `.`
- Production branch: `main`
- Automatic branching: enabled
- Deploy to production: enabled
- Preview Branch seed: `supabase/seed.sql`

Supabase Vercel integration は `product` Vercel project のみに接続する。`web` は今回の Supabase Preview Branch 切替対象外。

GitHub branch protection では Supabase integration の required check を有効化する。これにより、Preview Branch への migration 適用が失敗した PR は merge できない。

### リリースフロー全体像

```txt
feature branch → PR open
                  ├── Supabase: Preview Branch 作成 + migration 適用 + seed
                  └── Vercel: product Preview が Preview Branch env を参照

PR review → checks pass → main merge
                  ├── Supabase: main/production に migration 適用
                  └── Vercel: product Production deploy
```

Vercel Preview は production Supabase DB を参照しない。PR close / merge 後の Preview Branch は Supabase 側で削除または停止される。

### マイグレーション手順

#### 1. 作成

```bash
npm run migration:create <migration_name>
# supabase/migrations/YYYYMMDDHHMMSS_<migration_name>.sql を編集
```

#### 2. ローカル検証

```bash
supabase start
npm run db:reset
npm run db:seed
pnpm dev
```

#### 3. PR Preview 検証

PR を作成すると Supabase GitHub integration が Preview Branch を作成し、`supabase/migrations/**` を適用する。Vercel integration が `product` の Preview deployment に対応する Supabase env vars を注入する。

確認すること:

- Supabase PR check が green
- Vercel Preview が production DB ではなく Preview Branch を参照している
- migration に依存する機能が Preview URL で動く
- seed data だけで動作確認でき、本番データを必要としない

#### 4. Production 適用

`main` merge 後、Supabase GitHub integration が production に migration を適用する。GitHub Actions から `supabase db push` は実行しない。

### Emergency Runbook

通常運用では手動 `supabase db push` を使わない。Supabase integration 障害などで緊急対応が必要な場合だけ、Production の 1Password secret を使い、作業ログに理由を残して実行する。

`main` branch が `MIGRATIONS_FAILED` を示している場合は、先に失敗状態が production migration path の実体か、Preview Branch 側の古い状態かを確認する。production schema に未適用 migration があるまま launch-blocker の security migration を merge すると、Git 上では修正済みでも本番 DB へ反映されない。

確認すること:

- Supabase dashboard の production deployment / branch log に失敗した migration 名と SQL error が残っている
- production DB の `supabase_migrations.schema_migrations` 最新 version が repo の `supabase/migrations/` と一致している
- 不一致がある場合、未適用 migration を列挙して作業ログに残している
- 手動適用が必要な場合、`--dry-run` で適用対象 migration を確認し、対象 SQL の destructive change / backfill / lock risk と backup / PITR の状態を確認している

```bash
supabase link --project-ref yvglwblxrnrenfifsnje
supabase db push --dry-run
supabase db push
```

手動適用後は migration history を再確認し、Supabase branch status が解消されたか、または production path に影響しない非 authoritative な preview 状態だったことを作業ログに残す。

### マイグレーション統合時の注意

- [ ] RLS が有効で、`auth.uid() = user_id` の境界が維持されている
- [ ] 新規 table / view / RPC は `GRANT` を明示し、`RLS + policy + GRANT` を 1 セットでレビューしている
- [ ] `authenticated` への Data API 権限は必要最小限にしている
- [ ] `anon` への権限付与は公開読み取りなど明示理由がある場合だけに限定している
- [ ] service-role 専用 table / RPC は browser client から使えないことを RLS / GRANT の両方で確認している
- [ ] Realtime が必要な table だけ `supabase_realtime` publication に入っている
- [ ] `IF NOT EXISTS` / `IF EXISTS` で冪等化している
- [ ] ローカルで `db:reset` が通る
- [ ] `pnpm rls:snapshot` を再生成し、RLS / GRANT / Realtime publication の差分を確認している
- [ ] Supabase Preview Branch check が green
- [ ] Production 適用前に Vercel Preview で主要導線を確認した
- [ ] `DROP FUNCTION` / `CREATE FUNCTION` / `GRANT` / `REVOKE` を含む DDL は、下記「DDL のロックタイムアウト規約」に従い `BEGIN`/`COMMIT` + `lock_timeout` でラップしている

### DDL のロックタイムアウト規約

策定日: 2026-08-25（[#2360](https://github.com/Dayopt/dayopt/issues/2360)）

新規 migration で `DROP FUNCTION` / `CREATE FUNCTION` / `GRANT` / `REVOKE` など、既存オブジェクトに `ACCESS EXCLUSIVE` ロックを取る DDL を含む場合、`BEGIN` / `COMMIT` でラップし `lock_timeout` / `statement_timeout` を明示する。

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- DROP FUNCTION / CREATE FUNCTION / GRANT / REVOKE ...
COMMIT;
```

- **理由**: Supabase の migration runner は migration file を transaction で自動的に囲まない（CLI 実装の `ApplyMigrations` は明示コメントで "no transaction wrapping" としている）。明示的な `BEGIN` が無い statement は autocommit で実行されるため、ラップしなければ DDL 文自体のロック待ちが無制限になる
- 関数定義内に埋め込む `SET lock_timeout TO '5s'`（`proconfig`）は、その関数が **deploy 後に呼ばれる時**のランタイム保護であり、migration 自身の DDL 文（DROP/CREATE/GRANT/REVOKE）には効かない。目的が異なるため、proconfig と本規約は両方維持する
- **対象外**: `CREATE INDEX CONCURRENTLY` / `VACUUM` / `ALTER SYSTEM` / `CLUSTER` / `REINDEX CONCURRENTLY` など、トランザクション内で実行できない DDL を含む migration は本規約の対象外とする
- 既存の「ラップなし」migration（`20260818140000` 以降の DROP+CREATE FUNCTION 系）は不変資産のため遡及しない。今後の新規 migration にのみ適用する
- precedent: `supabase/migrations/20260809015344_optimize_soft_delete_rls_initplan.sql`

### GRANT / Realtime 監査

Supabase Data API / GraphQL API から新規 `public` object を使う時は、RLS だけでなく
`GRANT` が必要になる。migration review では以下を確認する。

- table: user data は `authenticated` に必要な `SELECT` / `INSERT` / `UPDATE` / `DELETE` だけを付与する
- view: `security_invoker = true` を使い、必要な role に `SELECT` を明示する
- RPC: app-facing 関数は `authenticated`、service-role 専用関数は `service_role` / platform role に限定する
- public read が必要な object 以外は `anon` に付与しない
- `CREATE OR REPLACE FUNCTION` は既存権限を保持しうるため、意図する `GRANT` / `REVOKE` を migration 内に明示する

権限と Realtime publication は snapshot に含める。migration 変更後は local DB に適用してから再生成する。

```bash
pnpm rls:snapshot
pnpm rls:snapshot:check
```

Realtime publication の手動確認 SQL:

```sql
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;
```

2026-07-08 時点の期待値は production / local ともに空。アプリコード側にも `postgres_changes`
購読はない。Realtime を再導入する時は、購読する table、必要な RLS policy、publication 追加理由を
同じ PR に残す。

### スキーマ変更を含むリリースの順序

| 変更種別         | 順序の原則                                   |
| ---------------- | -------------------------------------------- |
| 新カラム追加     | 先に DB、後にアプリ（デフォルト値必須）      |
| カラム削除       | 先にアプリ（参照除去）、後に DB              |
| 型変更           | 2 段階（新カラム追加 → backfill → 旧削除）   |
| NOT NULL 追加    | 先に backfill で全行埋める → 制約追加        |
| RLS ポリシー変更 | 新ポリシー追加 → アプリ更新 → 旧ポリシー削除 |

**「後に DB」側の migration（既存オブジェクトへの `REVOKE` / `DROP POLICY` / `DROP COLUMN` / `DROP TABLE` / `DROP FUNCTION` / `RENAME` / 列型変更）と product の runtime コード変更を同一 PR に束ねると、CI（`ci.yml` unit job の migration safety、`scripts/ci/check-destructive-migration.mjs` の coupled 判定）が落とす。** Supabase の GitHub 連携は main merge 時点で migration を production へ適用し、Vercel の promote は E2E 後の別 job なので、promote が失敗している間ずっと旧 build が新 schema に当たる（2026-09-08、#2672 で 5 時間 4 分）。同一 PR の新規 migration が作ったオブジェクト（`CREATE TABLE` / `CREATE FUNCTION` / `ADD COLUMN`）への縮小は旧 build が知らないので対象外。plain な destructive 検知（ラベル + コメント、fail open）は従来どおり。

### 関連

- skill: `.agents/skills/supabase/SKILL.md`
- secrets: `docs/operations/secrets.md`

---

## 災害復旧手順

策定日: 2026-08-12（[#1879](https://github.com/Dayopt/dayopt/issues/1879)）

**次節の §DB Migration Rollback 手順書 が「判断の巻き戻し」（自分が適用した migration を戻す）なのに対し、本節は「事故からの復旧」（データ消失・オペミス・DB 破損）を扱う。** 原因が自分の変更なら次節、失われたデータを取り戻すなら本節。

> **⚠ 本節の RTO / RPO はまだ実測されていない。** 復元演習は未実施で、手順は [復元演習手順書](../operations/disaster-recovery-drill.md) に用意済み。**演習を通していない経路を障害中にぶっつけで走らせることになる**前提で判断する。演習後にここへ実測値を書く。

### 復元でも戻らないもの

障害対応中に最初に知るべきはこれ。**DB backup をどう復元しても、以下は戻らない。**

| 対象                                              | なぜ                                                           | 戻し方                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage オブジェクト**                          | どの DB backup にも含まれない（Supabase の仕様）               | 搬出/復元 script（`scripts/ci/storage-backup.sh` / `scripts/runbook/storage-restore.sh`、rclone ベース）は実装済み。**destination（Cloudflare R2）を確定し、初回搬出・実復元演習ともに完了**（2026-08-20、[#2026](https://github.com/Dayopt/dayopt/issues/2026)）。以後は日次 cron が差分同期する。詳細は [disaster-recovery-drill.md](../operations/disaster-recovery-drill.md) §Storage |
| **Edge Functions とその secrets**                 | 復元対象外                                                     | `supabase functions deploy <slug> --use-api` で再デプロイ + **secrets を再投入**（`supabase secrets set`）。コードを戻しても secrets は戻らない                                                                                                                                                                                                                                           |
| **Vault の secrets（別 project へ復元した場合）** | 暗号鍵は project 単位。別 project では復号できない可能性が高い | 1Password から再投入する（`vault.secrets` に 9 件。`stripe_secret_key` / `resend_api_key` / `service_role_key` / `recovery_code_pepper` 等）                                                                                                                                                                                                                                              |
| **Realtime publication**                          | 別 project へ復元した場合は再有効化が必要                      | 現状 publication は空なので影響なし                                                                                                                                                                                                                                                                                                                                                       |

**production の pg_cron job は `supabase/migrations/` が正本ではない**（baseline に「本番は Dashboard で設定」とある）。復元の前後で `SELECT jobname, schedule, active FROM cron.job;` を控えて突き合わせる。

> custom role の password も backup に含まれないが、**現状 Dayopt に custom role は無い**（migration に `CREATE ROLE` / `CREATE USER` が 0 件）。追加したらこの表に足す。

### 復元前に止めるもの

**復元より前に書き込みを止める。** 止まっていないと、backup 時刻以降の書き込みが復元で丸ごと消える。

#### メンテナンスモードは書き込みを止めない（2026-08-12 実測）

`NEXT_PUBLIC_MAINTENANCE_MODE=true` が止めるのは**画面遷移だけ**。

- `apps/product/src/proxy.ts` はメンテナンス判定（`isMaintenanceMode`）より**前に** `pathname.startsWith('/api')` で早期 return する
- さらに `config.matcher` が `api` を除外しているので、`/api/trpc` と `/api/webhooks/*` は proxy を通らない

結果として、**既に画面を開いているユーザーの mutation と Stripe / Resend の webhook は、メンテナンスモード中も DB を更新し続ける**。「メンテナンスモードにしたから止まった」と判断すると、その間の書き込みを失う。

#### Write Fence（API層の書き込み停止、2026-08-13 実装、[#1972](https://github.com/Dayopt/dayopt/issues/1972)）

`public.write_fence_control`（singleton テーブル）を Dashboard SQL Editor から直接 `UPDATE` して on/off する。toggle 用の RPC / API は無い（app runtime に UPDATE 権限を与えると自己解除の穴になるため、postgres superuser 限定）。

```sql
UPDATE public.write_fence_control SET fence_enabled = true WHERE singleton_key = true;
```

fail-closed: `write_fence_control` の読み取りに失敗すると mutation は block 側に倒れる。ただし relation 自体が無い場合（migration 適用直後の deploy 競合窓）は disabled 扱いにして自己 DoS を避ける。読み取りは呼び出し元の client（tRPC = `ctx.supabase`、webhook = service role client）で行うため、fence の読み取り失敗は「その書き込みが元々失敗する状況」と一致する。

**fence が届く経路 / 届かない経路の一覧、toggle・drain・復旧手順は [runbook.md §Write Fence 有効化](../operations/runbook.md#write-fence-有効化api層の書き込み停止) が正本。** 要点だけ書くと、tRPC mutation・webhook 2 本・cron 2 本・oauth token・google-calendar callback には効くが、**client 直叩きの Supabase Auth / Storage、pg_cron、MCP write gate には効かない**。

#### いま実際に止められるもの

| 対象                                                                 | 手段                                                         | 影響                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| 画面からの操作                                                       | `NEXT_PUBLIC_MAINTENANCE_MODE=true`                          | 小                                         |
| tRPC mutation / webhook / cron 2本 / oauth token / calendar callback | Write Fence（上記）                                          | 中（read は通る。client 直叩き経路は残る） |
| MCP 経由の書き込み                                                   | 既存の write gate（`writes_enabled` / `enabled_client_ids`） | MCP 利用者のみ                             |
| pg_cron                                                              | 下記 SQL                                                     | cron 処理の停止                            |
| client 直叩きの Supabase Auth / Storage                              | **専用の手段が無い。** deployment を止めるしかない           | 大（サービス全停止）                       |

#### pg_cron を止める

pg_cron の job は Postgres 内部で独立に走るため、app 側を何をしても止まらない。

```sql
-- ① 先に控える。production の cron は Dashboard 設定が正本で、
--    migration から再生成できない。控えずに止めると復旧手段が消える
SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobname;

-- ② 控えた内容を保存してから止める
SELECT cron.unschedule(jobname) FROM cron.job WHERE active;
```

**①を飛ばさない。** 止めた job は復旧後に手で戻すことになり、控えが無いとスケジュールも command も分からなくなる。

### 復旧後に戻すもの（サービス再開前に確認する）

**止めたものは戻さないと恒久的に止まったままになる。** 特に backup 復元をせず rollback 経路へ抜けた場合、cron を止めたことだけが残る。

- [ ] **pg_cron を再登録する。** 控えた `jobname` / `schedule` / `command` から `SELECT cron.schedule('<name>', '<schedule>', '<command>');` で戻し、名前・schedule・command・`active` の一致を確認する
  - 対象は「止める前に控えた一覧の全件」。特定の job 名を思い出そうとしない — 個別列挙は増えるたびに更新漏れが起きる（2026-08-12、`cleanup-calendar-authority-retention` 追加時に本節が `expire-calendar-revoke-outbox` しか挙げていないことが指摘された）
  - 戻し忘れの実害の例: `expire-calendar-revoke-outbox`（期限切れ revoke の処理）が止まる、`cleanup-calendar-authority-retention`（90 日保持期限の cleanup、#1994）が止まって privacy policy の保持期間の約束を実装が満たさなくなる
- [ ] Edge Function とその secrets（別 project へ復元した場合）
- [ ] Auth Hook の登録（別 project へ復元した場合。§復元でも戻らないもの）
- [ ] 最後にメンテナンスモードを解除する

§DB Migration Rollback 手順書 の緊急対応フローチャートには pg_cron 停止ステップがあるが、災害復旧でも同じことが要る。

### 復旧経路の選択

| 状況                       | 経路                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| 自分の migration が原因    | §DB Migration Rollback 手順書（逆 SQL を新 migration として適用）                                       |
| データ消失・破損・オペミス | backup / PITR から復元。**production への in-place restore は破壊的で、実行中はプロジェクトが停止する** |
| schema だけ壊れた          | forward restoration migration（削除済みデータは戻らない）                                               |

**backup の保持期間と PITR の有効・無効は Dashboard でしか確認できない**（Management API の project endpoint は backup 情報を返さない。2026-08-12 実測）。障害中に「backup があるはず」で動かず、まず Dashboard で存在を確認する。

### 実測値

| 指標                             | 値                                                            |
| -------------------------------- | ------------------------------------------------------------- |
| RTO（復元開始 → 主要フロー通過） | **未実測**                                                    |
| RPO（失う最大時間幅）            | **未実測**（daily backup なら最大 24 時間、PITR なら約 2 分） |

手順の詳細・確認観点・中止条件は [復元演習手順書](../operations/disaster-recovery-drill.md) が正本。本節は結論と「戻らないもの」だけを持つ。

---

## DB Migration Rollback 手順書

本番デプロイ事故時の逆マイグレーションSQL集。Supabaseはネイティブのrollback機構を持たないため、**逆SQLを新しいマイグレーションとして適用する**方式で対応する。

**データ消失・オペミスからの復旧は本節の対象外。** その場合は §災害復旧手順 を読む。

> **対象**: `supabase/migrations/` 配下の全17マイグレーション（baseline除く）

### 緊急対応フローチャート

```
1. 障害検知
   ↓
2. メンテナンスモード有効化
   NEXT_PUBLIC_MAINTENANCE_MODE=true を Vercel で設定
   ↓
3. 影響範囲特定
   どのマイグレーションが原因か特定する
   ↓
4. バックアップ取得
   該当テーブルの事前バックアップSQLを実行（下記参照）
   ↓
5. pg_cron ジョブ停止（Vault/Edge Function関連の場合）
   SELECT cron.unschedule('ジョブ名');
   ↓
6. ロールバックSQL実行
   Supabase Dashboard > SQL Editor で実行
   ※ 依存関係に注意: 新しいものから逆順に適用
   ↓
7. マイグレーション履歴更新
   DELETE FROM supabase_migrations.schema_migrations
   WHERE version = 'ロールバックしたバージョン';
   ↓
8. アプリ動作確認
   Staging で確認後、メンテナンスモード解除
```

### カテゴリ別ロールバック方針

| 操作                        | ロールバック方法              | データ損失   |
| --------------------------- | ----------------------------- | ------------ |
| CREATE TABLE                | DROP TABLE                    | あり         |
| ALTER TABLE ADD COLUMN      | ALTER TABLE DROP COLUMN       | あり         |
| CREATE INDEX                | DROP INDEX                    | なし         |
| CREATE EXTENSION            | DROP EXTENSION                | なし（通常） |
| CREATE FUNCTION             | DROP FUNCTION                 | なし         |
| CREATE OR REPLACE FUNCTION  | 旧版で CREATE OR REPLACE      | なし         |
| DROP POLICY + CREATE POLICY | 旧ポリシーで DROP + CREATE    | なし         |
| GRANT/REVOKE                | 逆の REVOKE/GRANT             | なし         |
| ALTER TABLE ADD CONSTRAINT  | ALTER TABLE DROP CONSTRAINT   | なし         |
| Data migration (UPDATE)     | **不可逆** — バックアップ必須 | —            |

### 各マイグレーションの逆SQL

> **注意（2026-07-13）**: 以下の `entries` を対象にした逆SQLは当時の履歴であり、Step 9b で `entries` を削除した現在の schema には直接適用しない。Step 9b より前へ戻す必要がある場合は、個別の逆SQLではなく backup / PITR と time-model migration の再適用で復旧する。

#### 1. `20260317022728_fix_security_definer_idor.sql`

| 項目       | 値                                                     |
| ---------- | ------------------------------------------------------ |
| 内容       | SECURITY DEFINER関数にauth.uid()チェック追加（13関数） |
| リスク     | LOW                                                    |
| データ損失 | なし                                                   |

> **ロールバック非推奨**: セキュリティ修正。ロールバックするとIDOR脆弱性が復活する。

逆SQL: `00000000000000_baseline.sql` から元の関数定義を取り出し `CREATE OR REPLACE` で上書き。auth.uid()チェックを含まない版に戻す。

#### 2. `20260317040426_add_entry_time_overlap_constraint.sql`

| 項目       | 値                             |
| ---------- | ------------------------------ |
| 内容       | btree_gist拡張 + EXCLUSION制約 |
| リスク     | LOW                            |
| データ損失 | なし                           |

```sql
-- ロールバック
ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS entries_no_time_overlap;
-- btree_gist は他で使用していなければ削除可:
-- DROP EXTENSION IF EXISTS btree_gist;
```

#### 3. `20260317040428_add_reminder_idempotency.sql`

| 項目       | 値                               |
| ---------- | -------------------------------- |
| 内容       | notifications UNIQUEインデックス |
| リスク     | LOW                              |
| データ損失 | なし                             |

```sql
DROP INDEX IF EXISTS public.idx_notifications_entry_type_unique;
```

#### 4. `20260317100000_add_ical_feed_token.sql`

| 項目       | 値                                      |
| ---------- | --------------------------------------- |
| 内容       | user_settings に ical_feed_token カラム |
| リスク     | MEDIUM                                  |
| データ損失 | あり（iCalフィードURL無効化）           |

```sql
-- 事前バックアップ
CREATE TABLE _backup_user_settings_ical AS
SELECT user_id, ical_feed_token FROM user_settings
WHERE ical_feed_token IS NOT NULL;

-- ロールバック
DROP INDEX IF EXISTS idx_user_settings_ical_feed_token;
ALTER TABLE user_settings DROP COLUMN IF EXISTS ical_feed_token;
```

復旧: ユーザーが設定画面からトークンを再生成する必要あり。

#### 5. `20260317120000_add_stripe_billing_columns.sql`

| 項目       | 値                                                                   |
| ---------- | -------------------------------------------------------------------- |
| 内容       | profiles に stripe_customer_id, subscription_status, subscription_id |
| リスク     | **HIGH**                                                             |
| データ損失 | あり（課金データ消失）                                               |

```sql
-- 事前バックアップ（必須）
CREATE TABLE _backup_profiles_billing AS
SELECT id, stripe_customer_id, subscription_status, subscription_id
FROM profiles
WHERE stripe_customer_id IS NOT NULL;

-- ロールバック
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS chk_subscription_status;
DROP INDEX IF EXISTS idx_profiles_stripe_customer_id;
ALTER TABLE profiles
  DROP COLUMN IF EXISTS subscription_id,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS stripe_customer_id;
```

復旧: `_backup_profiles_billing` からカラム再追加 + INSERT で復元。

#### 6. `20260318083030_optimize_tag_sort_and_rls.sql`

| 項目       | 値                                        |
| ---------- | ----------------------------------------- |
| 内容       | increment_tag_sort_orders関数 + RLS最適化 |
| リスク     | LOW                                       |
| データ損失 | なし                                      |

```sql
DROP FUNCTION IF EXISTS public.increment_tag_sort_orders(UUID);

-- reflections RLS（bare auth.uid() 版に戻す）
DROP POLICY IF EXISTS "Users can view own reflections" ON public.reflections;
CREATE POLICY "Users can view own reflections" ON public.reflections
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own reflections" ON public.reflections;
CREATE POLICY "Users can create own reflections" ON public.reflections
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own reflections" ON public.reflections;
CREATE POLICY "Users can update own reflections" ON public.reflections
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own reflections" ON public.reflections;
CREATE POLICY "Users can delete own reflections" ON public.reflections
  FOR DELETE USING (auth.uid() = user_id);

-- notification_preferences INSERT
DROP POLICY IF EXISTS "Users can insert own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can insert own notification preferences" ON public.notification_preferences
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
```

#### 8. `20260318090000_create_get_time_by_tag_function.sql`

| 項目       | 値                  |
| ---------- | ------------------- |
| 内容       | get_time_by_tag関数 |
| リスク     | LOW                 |
| データ損失 | なし                |

```sql
DROP FUNCTION IF EXISTS public.get_time_by_tag(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
```

#### 9. `20260318091249_create_email_suppressions.sql`

| 項目       | 値                          |
| ---------- | --------------------------- |
| 内容       | email_suppressions テーブル |
| リスク     | MEDIUM                      |
| データ損失 | あり（バウンス記録消失）    |

```sql
-- 事前バックアップ
CREATE TABLE _backup_email_suppressions AS SELECT * FROM email_suppressions;

-- ロールバック
DROP TABLE IF EXISTS public.email_suppressions CASCADE;
```

#### 10. `20260318120000_create_stats_kpi_functions.sql`

| 項目       | 値                                       |
| ---------- | ---------------------------------------- |
| 内容       | KPI関数7つ                               |
| リスク     | LOW                                      |
| データ損失 | なし                                     |
| 依存       | **先に #11, #12 をロールバックすること** |

```sql
DROP FUNCTION IF EXISTS public.get_plan_rate(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_estimation_accuracy(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_context_switches(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_blank_rate(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.get_energy_map(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_cumulative_time(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_avg_fulfillment(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
```

#### 11. `20260318130000_fix_stats_context_switches_and_energy_map.sql`

| 項目       | 値                                                  |
| ---------- | --------------------------------------------------- |
| 内容       | KPI関数のauth.uid()チェック + TZ対応 + REVOKE/GRANT |
| リスク     | LOW                                                 |
| データ損失 | なし                                                |

> **ロールバック非推奨**: auth.uid()チェック（セキュリティ修正）を含む。

逆SQL: `20260318120000` の関数定義で `CREATE OR REPLACE`（auth.uid()チェックなし版）+ PUBLIC への GRANT 復元。

```sql
-- REVOKE authenticated + GRANT PUBLIC に戻す（セキュリティ低下）
REVOKE ALL ON FUNCTION public.get_plan_rate(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_plan_rate(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO PUBLIC;
-- 他6関数も同様...

-- + 20260318120000 の関数定義で CREATE OR REPLACE（auth.uid()チェックなし）

-- 旧 get_energy_map(UUID, DATE, DATE) overload を復元する場合:
-- 20260317022728 の get_energy_map 定義を参照
```

#### 12. `20260318140000_create_stats_kpi_summary.sql`

| 項目       | 値                            |
| ---------- | ----------------------------- |
| 内容       | get_stats_kpi_summary統合関数 |
| リスク     | LOW                           |
| データ損失 | なし                          |

```sql
REVOKE ALL ON FUNCTION public.get_stats_kpi_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) FROM authenticated;
DROP FUNCTION IF EXISTS public.get_stats_kpi_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER);
```

#### 13. `20260318150000_add_entries_soft_delete.sql`

| 項目       | 値                                            |
| ---------- | --------------------------------------------- |
| 内容       | entries に deleted_at カラム + SELECT RLS更新 |
| リスク     | **HIGH**                                      |
| データ損失 | あり（ソフトデリート区別が消失）              |
| 依存       | **先に #17 をロールバックすること**           |

```sql
-- 事前バックアップ（必須）
CREATE TABLE _backup_entries_soft_deleted AS
SELECT id, user_id, title, deleted_at FROM entries WHERE deleted_at IS NOT NULL;

-- ロールバック
DROP POLICY "Users can view own plans" ON public.entries;
CREATE POLICY "Users can view own plans" ON public.entries
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP INDEX IF EXISTS idx_entries_deleted_at;
ALTER TABLE public.entries DROP COLUMN IF EXISTS deleted_at;
```

復旧: ロールバック後、ソフトデリート済みデータはHARD DELETEされた状態になる。`_backup_entries_soft_deleted` から復元するには、deleted_at カラムを再追加して UPDATE する。

#### 14. `20260319000000_enable_vault.sql`

| 項目       | 値                                |
| ---------- | --------------------------------- |
| 内容       | supabase_vault拡張                |
| リスク     | **HIGH**                          |
| データ損失 | あり（Vault内シークレット全消失） |

> **ロールバック非推奨**: pg_cronジョブ、Edge Function呼び出しが全て停止する。

```sql
-- CASCADE: 依存する関数 (vault_secret_exists) も削除される
DROP EXTENSION IF EXISTS supabase_vault CASCADE;
```

#### 15. `20260319000001_vault_helper_functions.sql`

| 項目       | 値                                                                            |
| ---------- | ----------------------------------------------------------------------------- |
| 内容       | get_vault_secret（**撤去済み**）, vault_secret_exists                         |
| リスク     | MEDIUM                                                                        |
| データ損失 | なし                                                                          |
| 依存       | `get_vault_secret` は `20260917050000` が撤去済み。#16 の事前 rollback は不要 |

```sql
DROP FUNCTION IF EXISTS public.vault_secret_exists(TEXT);
```

#### 16. `20260319000003_vault_invoke_edge_function.sql`

| 項目       | 値                                       |
| ---------- | ---------------------------------------- |
| 内容       | invoke_edge_function関数（**撤去済み**） |
| リスク     | —                                        |
| データ損失 | なし                                     |

`20260917050000_drop_vault_edge_invoke.sql`（[#2733](https://github.com/Dayopt/dayopt/issues/2733)）が
`invoke_edge_function` と `get_vault_secret`、および vault secret の `service_role_key` /
`supabase_url` を撤去した。**この migration へのロールバック手順はもう要らない。**

撤去の根拠（#2517 の production read-only 実測）: `cron.job` は 5 本でどれも Edge も pg_net も
呼ばず、`net._http_response` が存在しない（pg_net 自体が未導入）。TS からの `.rpc` 呼び出しも
ゼロだった。定義を戻す必要が生じた場合は `20260319000001` / `20260319000003` を再適用する。

#### 17. `20260319083000_rls_audit_fixes.sql`

| 項目       | 値                                               |
| ---------- | ------------------------------------------------ |
| 内容       | storage UPDATEポリシー + soft-deleteフィルタ追加 |
| リスク     | LOW                                              |
| データ損失 | なし                                             |

```sql
-- storage ポリシー削除
DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;

-- entry_tags SELECT（soft-deleteフィルタなし版に戻す）
DROP POLICY IF EXISTS "Users can view own plan_tags" ON public.entry_tags;
CREATE POLICY "Users can view own plan_tags" ON public.entry_tags
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

```

#### 18. `20260319090000_create_stripe_webhook_events.sql`

| 項目       | 値                             |
| ---------- | ------------------------------ |
| 内容       | stripe_webhook_events テーブル |
| リスク     | LOW                            |
| データ損失 | あり（冪等性ログ消失、実害低） |

```sql
DROP TABLE IF EXISTS public.stripe_webhook_events CASCADE;
```

### ロールバック依存関係

逆順で適用すること。特に重要な依存チェーン:

```
#17 → #13 (soft_delete)     ← #17が13のdeleted_atカラムに依存
#15 → #14 (vault)           ← vault_secret_exists → extension（#16 は撤去済みで鎖から外れた）
#12 → #11 → #10 (stats)     ← summary → fix → kpi_functions
```

**安全なロールバック順序**（最新から）:

```
18 → 17 → 16 → 15 → 14 → 13 → 12 → 11 → 10 → 9 → 8 → 7 → 6 → 5 → 4 → 3 → 2 → 1
```

### 共通チェックリスト

#### ロールバック前

- [ ] メンテナンスモード有効化（`NEXT_PUBLIC_MAINTENANCE_MODE=true`）
- [ ] 該当テーブルのバックアップSQL実行
- [ ] pg_cronジョブ停止（Vault関連の場合）
- [ ] Stripeの受信Webhook一時停止（課金関連の場合）
- [ ] 影響を受けるtRPCルーターの確認

#### ロールバック後

- [ ] `supabase_migrations.schema_migrations` から該当レコード削除
- [ ] Staging環境で動作確認
- [ ] メンテナンスモード解除
- [ ] アプリの主要機能（ログイン、予定/記録の作成、カレンダー表示）の手動確認

#### マイグレーション履歴の更新

```sql
-- ロールバックしたマイグレーションを履歴から削除
DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260319090000';  -- 該当バージョンに置き換え
```

### リスクサマリー

| リスク     | マイグレーション                                                              |
| ---------- | ----------------------------------------------------------------------------- |
| **HIGH**   | #5 (stripe billing), #13 (soft delete), #14 (vault)                           |
| **MEDIUM** | #4 (ical token), #9 (email suppressions), #15 (vault helpers)。#16 は撤去済み |
| **LOW**    | #1-3, #6, #8, #10-12, #17-18                                                  |
| **非推奨** | #1 (IDOR fix), #11 (auth.uid() check), #14 (vault extension)                  |

## 出口コスト台帳

策定日: 2026-08-09（経緯は 2026-08-09-antifragility-stance.md（削除済み、git 履歴参照））

**乗り換え準備ではなく防災マップ。** 各依存について「今日捨てたら何が壊れるか」を知っておくことが目的で、adapter 層などの事前対策は取らない（YAGNI）。新規依存の採用判断では、この台帳のどの深さに相当するかを基準点にする（`AGENTS.md` §技術選定スタンス）。

更新するのは 3 つの時: ①「深い」「中」級の依存を追加・削除した時、②**既存依存の用途・浸透範囲が変わった時**（新しい呼び出し面を足す、cron を増やす、必須 env に昇格させる等。依存の増減が無くても「今日捨てたら何が壊れるか」は変わる）、③出口検討トリガーに当たる発表・事象があった時。

### 台帳の粒度（保証境界）

策定日: 2026-08-09（[PR #1880](https://github.com/Dayopt/dayopt/pull/1880) のレビュー 2 ラウンド目で境界を明文化）

**この台帳が保証するのは「どの外部サービスに依存していて、捨てたら何が壊れ、どの層か」まで。** 粒度の下限は **その依存を捨てる／続ける判断が変わる情報**とする。

- **対象内**: 依存の列挙漏れ、層の誤り、「捨てたら壊れるもの」の誤り。これらは判断そのものを誤らせる
- **対象外**: 既に列挙済みの依存について、移行手順を 1 段細かくする記述（オブジェクト搬出に加えた URL 書き換え、DNS レコードの移行順序など）。**台帳は移行手順書ではない**

実際に乗り換える時は、その時点で対象サービスの棚卸しをやり直す前提とする。台帳は「どこから調べ始めるか」の起点であって、網羅した移行チェックリストではない。この境界を引かないと、列挙済みの依存を無限に細分化する指摘が構成でき、防災マップとしての可読性が先に死ぬ（同型指摘の打ち切りは [workflow.md §同型指摘の打ち切り](../../AGENTS.md §PR / git 運用)）。

### 深い（乗り換えは週単位の大工事）

| 依存         | 浸透                                                                                     | 今日捨てたら何が壊れるか                                             | 逃げ道                                                                                                                                                                                       | 出口検討トリガー                                     |
| ------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Supabase** | Auth + DB 本体（RLS / RPC）+ Storage（`avatars` bucket）+ Edge Functions。唯一の最深依存 | 認証、全データアクセス、avatar の保存・配信、認証メール送信 function | schema / migration は repo に全履歴があり Postgres 互換先へ dump 移行できるが、**Storage オブジェクトは DB dump に入らないので別途搬出が要る**。Auth / RLS / Edge Functions の作り直しが本体 | 価格・無料枠の大幅改定、買収・方針転換、障害の常態化 |

**Realtime は現状の浸透に含めない。** `supabase_realtime` publication は production / local ともに空で、アプリ側にも `postgres_changes` 購読が無い（本ファイル §Supabase 型自動生成 の Realtime publication 手動確認 SQL）。再導入したらこの行を更新する。

### 中（乗り換えは日単位）

| 依存                                   | 浸透                                                                                                                                                                                                                                                                                                                                                                                                                      | 今日捨てたら何が壊れるか                                                                                                                                               | 逃げ道                                                                                                                                                                                                                                                                                              | 出口検討トリガー                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Vercel**                             | product / web のホスティング、build 内 bundle 検査、merge gate の commit status、**Cron**（`calendar-sync` / `external-connection-maintenance` を 15 分毎、`calendar-account-deletion-settle` を毎時、`billing-reconciliation` を日次）、**host 別 rewrite**（`mcp.dayopt.app` → `/api/mcp`）、**`dayopt.app` の registrar**（DNS zone 自体は Cloudflare へ委任済み。次項の Cloudflare 行、§DNS 管理（Cloudflare） 参照） | deploy 経路、PR 検証の一部、**カレンダー同期と接続メンテナンスの定期実行**、**MCP の入口 routing**、**ドメインの更新・移管権限**（DNS レコードそのものへの影響は無い） | Next.js は他ホスト（Cloudflare / Netlify / self-host）で動く。CI 配線に加え **scheduler と host routing の移植**（`apps/product/vercel.json`）と **registrar 移管**が要る。ホスティングだけ移して account を閉じるとドメインを失う                                                                  | 価格改定、他ホストでの Next.js 冷遇 |
| **Stripe**                             | Pro 課金（billing）+ **アカウント削除フロー**（subscription cancel → customer 削除）                                                                                                                                                                                                                                                                                                                                      | 課金・サブスク管理に加え、`stripe_customer_id` を持つユーザーの**アカウント削除が完了しなくなる**                                                                      | 代替決済へ切替可能だが、既存サブスクの移行（解約 → 再契約）と**削除フローの customer cleanup 差し替え**が要る                                                                                                                                                                                       | 手数料改定、アカウント凍結リスク    |
| **GitHub**                             | issue / PR 運用、Actions CI、`branch:finish` の REST 依存、**deployment の所有権**（Supabase integration が migration / Edge Function / Storage bucket の deploy owner、Vercel の唯一の deployment source、`promote.yml` が production domain promote の唯一経路）                                                                                                                                                        | 開発運用の全経路に加え、**アプリと DB の production deploy が両方止まる**                                                                                              | git 自体は分散。CI workflow と運用 script の書き直しに加え、**Supabase / Vercel integration と release 経路の再配線**が主コスト                                                                                                                                                                     | 価格改定、Actions 課金の構造変化    |
| **Upstash Redis**                      | rate limit（tRPC / OAuth token endpoint / MCP request）+ Resend webhook の exactly-once 処理リース                                                                                                                                                                                                                                                                                                                        | **operational 環境ではアプリが起動しない**（env 検証が失敗）。起動しても webhook 処理が fail-closed になる                                                             | `@upstash/redis` は REST API 前提のため素の Redis へ drop-in で移れない。rate limit は degrade で凌げるが、webhook の冪等性は代替ストア（Postgres 等）の実装が要る                                                                                                                                  | 価格改定、REST API の互換性変更     |
| **Google**                             | OAuth ログイン + external-calendar 連携 + **`support@dayopt.app` の最終受信箱**（Gmail destination と Send mail as）                                                                                                                                                                                                                                                                                                      | Google ログインユーザーのアクセス、カレンダー同期、**問い合わせの受信と返信**                                                                                          | ログインは email 併存、連携は opt-in。ただし**受信箱は代替が要る**（destination 変更・履歴移行・返信経路の再設定。`docs/operations/contact-email.md`）                                                                                                                                              | OAuth / Calendar API の政策変更     |
| **Cloudflare**                         | `dayopt.app` の **authoritative DNS**（`app` / `mcp` / `www` を含む）、**Email Routing**（`support@` → Gmail）、Turnstile（Bot 対策）                                                                                                                                                                                                                                                                                     | **全ドメインの名前解決**と**問い合わせの受信**、Bot 対策                                                                                                               | nameserver を別 DNS へ委譲し直し、MX / SPF / DKIM と転送先を再設定、CAPTCHA を差し替える。DNS の切替は伝播待ちを伴う                                                                                                                                                                                | 価格改定、無料枠の縮小              |
| **Sentry**                             | エラー監視（runtime capture / sanitizer / CSP report）+ **production build gate**（`assertProductionSentryBuildEnv` が資格情報欠落で build を失敗させる。product / web 両方）                                                                                                                                                                                                                                             | 監視に加え、**次の production build が止まる**                                                                                                                         | 代替 APM への移植は build 配線・sanitizer・CSP・運用 runbook を含むため日単位。履歴は持ち出さない割り切り                                                                                                                                                                                           | 価格改定、無料枠の縮小              |
| **Resend**                             | メール送信 + **bounce / complaint webhook**（svix 署名検証 → `email_suppressions` 更新）                                                                                                                                                                                                                                                                                                                                  | 送信に加え、**新規 bounce / complaint が記録されなくなり、抑止対象へ送り続ける**                                                                                       | 代替 SMTP / API へ切替。suppression list の持ち出しに加え、**webhook 署名検証・イベント変換・冪等性の再実装**が要る                                                                                                                                                                                 | 価格改定、到達率の劣化              |
| **1Password**                          | 長寿命 secret の **master**（Vercel / GitHub / Supabase は replica）、`op run` 注入、GitHub SSH 鍵、各サービスの password / TOTP / recovery code、ドメイン管理情報                                                                                                                                                                                                                                                        | secret の rotation 元と**アカウント復旧手段**（TOTP / recovery code / SSH 鍵）                                                                                         | `.op-env` スキーマだけでなく、**master secret・外部 replica の同期元・SSH agent・login / recovery item** をまとめて別 manager へ移す必要がある（`docs/operations/secrets.md`）                                                                                                                      | 価格改定、desktop 統合の劣化        |
| **Anthropic / Claude**（開発プロセス） | CLAUDE.md / rules / skills / agents が Claude Code 前提                                                                                                                                                                                                                                                                                                                                                                   | 開発テンポ（プロダクトは無傷）。**実装・運用を引き継ぐ agent が現行ポリシー上いない**ため、修正と release が止まる                                                     | 規約はすべて plain markdown で repo 内。ただし AGENTS.md は Codex を**レビュー専任**と定めていた（2026-08-13 時点で運用停止、規則は凍結保存）ため、稼働時点でも二系統は代替経路にならなかった。出口作業は「規約と workflow を別の実装系へ移植する」こと。tier 読み替え原則で model 名には固定しない | 価格・品質・提供条件の変化          |

### 浅い（乗り換えは時間単位、単機能で代替容易）

| 依存                  | 役割                                         | 逃げ道                                                        |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| **UptimeRobot**       | 外形監視                                     | 代替外形監視へ切替（Read-only API 運用）                      |
| **Have I Been Pwned** | signup / password 変更時の漏洩パスワード検査 | 停止時は fail-open（検査を通す）。代替 breach API / corpus へ |

**Turnstile と Sentry はこの層に無い。** Turnstile は Cloudflare 行（中）に、Sentry は production build gate を握るため中層に含めた。
