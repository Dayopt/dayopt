---
status: current
last_verified: 2026-09-22
code:
  - .github/workflows/ci.yml
  - .github/workflows/promote.yml
  - .github/workflows/nightly.yml
  - scripts/ci/check.mjs
  - scripts/ci/e2e-retry-report.mjs
  - apps/product/playwright.config.ts
---

# テストの置き場所と回し方

「この変更は何を確かめたから出せるのか」「壊れたらどこで気づき、次にどう強くなるのか」に答えるための正本。テスト本数と coverage は目標にしない。各 suite の CI 上の現況表は [infra.md §テスト自動化の現在地](infra.md#テスト自動化の現在地)、merge を止める条件は [infra.md §merge gate の required checks](infra.md#merge-gate-の-required-checks)。

## 層ごとの責務

| 層                            | 証明すること                                 | Dayopt の例                                         | 回る場所                                  |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| Static                        | コードとして成立している                     | typecheck / lint / boundaries / knip                | pre-push、PR（ci.yml）                    |
| Unit（Vitest）                | 小さなロジックが正しい                       | 時刻計算、重なり判定、集計、状態遷移                | PR は related、nightly で full            |
| Storybook + Vitest            | UI 部品の状態・操作・a11y                    | editor、activity picker、Report 部品                | main push（promote.yml 層 3）             |
| Integration（local Supabase） | 部品・DB・API をつないでも正しい             | RLS、RPC、migration 契約（fresh）                   | DB を触る PR（ci.yml）                    |
| DB upgrade（local Supabase）  | 既存データからの更新と旧アプリ互換           | base + seed → candidate、fresh との一致、契約縮小   | migration を追加した PR（ci.yml、shadow） |
| E2E（Playwright）             | ユーザーが中核の目的を end-to-end で達成する | Plan → Record → reload → Report（desktop / mobile） | main push（promote.yml 層 3）             |
| 契約 / 監査                   | 横断リスク                                   | workflow contract、production config audit          | PR / main push / 日次                     |
| 探索（dogfooding）            | まだ知らない問題                             | 迷い、余計な一手、状態不整合                        | オンデマンド（gate にしない）             |

E2E は万能にしない。小さい問題は小さい層で守り、E2E は中核ループに絞る。mobile は全 spec を二重実行せず、`@mobile` tag を付けた test だけが `Mobile Chrome` project で走る（長押し作成・Drawer・ヘッダーナビのように desktop と操作境界が違うものだけ）。

## いつ回すか

安く速いものほど頻繁に、重いものほど節目で回す。コードが変わらないのに同じ検査を毎日回すことは目的にしない。

1. **作業中**: 変更を証明する最小の層をローカルで回す
2. **push**: pre-push が affected な typecheck / lint、scripts test、format を回す
3. **ready 化した PR**: ci.yml の Static / Unit / 影響に応じた Integration。product unit は `vitest related`（変更が import graph で届く test）に絞る。graph で追えない変更（`packages/*`、設定、test setup、未知の path）を含む PR は full。src を fs で読む契約 test は毎回走る（`scripts/ci/check.mjs` の `resolveProductUnitScope`）
4. **main push**: promote.yml の層 3（影響のある project の E2E、desktop + `@mobile`、Storybook light / dark）が green の時だけ production へ promote
5. **nightly / 日次**: 自分が変えなくても変わるもの（production config drift、replica、backup）と、PR で絞った product unit の full 実行（`product-unit-full`）

nightly の full が落ちたら、落ちた test を直すのに加えて、PR の判定が拾えなかった依存の種類を full 側へ倒す規則に足す。

## Storybook の実行契約

`promote.yml` の専用 `storybook` job が、collect 検査と light / dark の render・play・a11y を実行する。両 app の配信中 SHA のうち、target の祖先と確認できる最も新しい SHA を共通基準に、product / web / 共有 UI / Storybook 設定と実行経路の変更を拾う。片方だけ昇格した後に古い app の SHA から同じ変更を繰り返し検査しない。配信 SHA の欠落・履歴の分岐・判定不能時は実行する。失敗・cancel・判定出力欠落は通常の promote を通さず、失敗通知は既存経路へ接続する。既存の force による緊急復旧は維持する。

- collect: `pnpm exec tsx scripts/tasks/check-story-coverage.ts --collected`
- 両テーマ: `pnpm --filter @dayopt/product exec vitest run --project storybook --project storybook-dark`
- JSON 結果は `storybook-results-<attempt>` artifact に7日保持する。workflow 全体の成功だけでなく、当該 job の実行と失敗件数を確認する。
- 全件を per-PR に追加しない。E2E と専用 job を並列実行して所要を分離する。cold cache と GitHub runner の実測は PR / Issue の証跡に残す。
- テーマは自動登録された framework 設定を保持して拡張する test project の `testTheme` を正本とし、DOM と theme context に同じ値を渡す。各 Story の終了時に実際の DOM class / color-scheme も検査する。ツールバーによる上書きで dark suite が light のまま通ることを防ぐ。
- AllPatterns は一覧展示、独立 Story は各状態の検査を担う。複数のページ用ランドマークは article に収める。同じ名前のランドマークが重複する一覧展示は `docs-only` とし、展示する全状態を独立 Story で検査する。個別 Story の展示タグはファイル全体の collect 対象を消さない。
- modal menu は閉じた状態で画面全体を検査し、開いた状態ではメニューを検査する。併せて背景への直接 focus・Tab・Shift+Tab がメニュー内に留まり、Escape で trigger に戻ることを実操作で検査する。axe の modal 判定が menu を認識しないための範囲指定であり、ルール自体は無効化しない。

復元可能性の実演は #1879 の独立した未完了事項。これらの自動テストの成功を DB 復元演習の成功に読み替えない。

## 回帰テストを足す基準

バグを見つけるたびに E2E を増やさない。

1. 失敗を再現する
2. 原因に最も近い**最小の層**を選ぶ（時刻計算は Unit、tenant 分離は Integration、editor の error state は Storybook、reload 後に消えるなら E2E）
3. 修正前に赤、修正後に緑を確認する（緑だけでは test が挙動を証明しない。AGENTS.md TEST-1）
4. 中核ループを壊すクラスの時だけ、上の層にも 1 本足す

PR 本文には「どの層に赤を入れたか」を 1 行書く。

## retry と flaky

- `retries: 2` は一時的な障害からの復旧手段で、合格基準ではない
- 層 3 の各 job は `scripts/ci/e2e-retry-report.mjs` が first-pass / retry-pass / failed を分け、run の Step Summary と warning 注釈に retry-pass を出す。JSON report は artifact に残る
- retry-pass では promote を止めない。止めるのは reporter が消えて retry-pass が見えなくなった時だけ（E2E が success なのに JSON が無い）
- 同じ test が 2 run 続けて retry-pass になったら flaky として issue にする。原因は network / 外部依存と product の回帰を分けて書く
- `test.skip` / `describe.skip` で隠さない。どうしても止める時は理由と期限の issue 番号を同じ行に書く。時間不変条件の test を消す・skip する PR の扱いは AGENTS.md の retreat 条件に従う
- CI で一度も走らない test は腐る（2026-09-14、`Mobile Chrome` が local 専用だった間に mobile-navigation の assertion が UI 変更に追従しないまま残っていた）。local 専用の suite を作らない

## Actions 予算（private repo 前提）

private repo の標準 GitHub-hosted runner は Team の月 3,000 分を消費する。Actions 予算は `$0` かつ上限到達時停止を維持するため、枠を使い切ると翌 billing cycle まで GitHub-hosted workflow が止まる。課金単価は runner OS ごとに異なり、現行の基準単価は Linux 2-core `$0.006/分`、Windows 2-core `$0.010/分`、macOS `$0.062/分`。一律 `$0.008/分` ではない。詳細は [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) と [Team に含まれる利用量](https://docs.github.com/en/billing/reference/product-usage-included) を参照。

**private 化の前提目標は月 2,400 分以下**（3,000 分の 80%）とする。Public runner の実行時間からの推計であり、private 標準 runner は Ubuntu が 4 CPU / 16 GB から 2 CPU / 8 GB になるため、private 化後の実時間は増える可能性がある。余裕を残せない推計なら public のままにする。

実測スナップショット（2026-09-21〜27 UTC、job ごとに分を切り上げ、GitHub REST API から取得）:

| workflow                | 7 日の推計分 | runner job 数 | 取消済み分 |
| ----------------------- | -----------: | ------------: | ---------: |
| CI                      |          858 |           276 |         27 |
| Production Config Audit |          100 |            97 |          0 |
| Nightly                 |           59 |            26 |          0 |
| Production Release      |          360 |           104 |          0 |
| Validation shadow       |           74 |            74 |          0 |
| Validation gate         |          923 |           749 |        352 |
| **合計**                |    **2,374** |     **1,326** |    **379** |

job 履歴からの単純な 30 日換算は **10,174 分**。これは最適化変更前の public runner 履歴であり、private の請求実績ではない。GitHub Billing Usage 画面は account-scoped な実請求単位を表示するため、private 化の最終判断では画面上の最新 billing cycle と Team の 3,000 分枠を照合する。短い job が多いだけでなく、Validation gate の取消済み実行にも週 352 分を使っていた。

上位 job（同じ週）:

| workflow           | job                    | job 数 | 推計分 |
| ------------------ | ---------------------- | -----: | -----: |
| Validation gate    | Validation (shadow)    |    749 |    923 |
| CI                 | 📦 Unit Tests          |     67 |    273 |
| CI                 | 🔍 Static Checks       |     74 |    256 |
| CI                 | 🧪 Integration Tests   |     38 |    187 |
| Production Release | 🎭 E2E Tests           |     17 |    134 |
| Production Release | Storybook light / dark |     17 |    117 |

GitHub は private repo の billable job duration を次の 1 分へ切り上げて表示し、その画面の分数には runner multiplier が含まれない。API からの public-run 推計と請求画面は照合方法が異なるため、集計結果は budget decision の根拠の一つとして扱う。

消費を決めるのは 1 run の重さより回数。置き場所の規則:

- **per-PR の job は 1 本 6 分以内**。重いものを per-PR に足さない
- **main push の層 3 job は 1 本 10 分以内**。mobile E2E は既存の e2e job に同居させる（build と webServer を共有）
- **新しい job より既存 job の step**。1 分未満の job も 1 分に切り上がる
- **コードが変わらなくても変わるものだけを nightly に置く**

### 予算レバー台帳

| レバー                                                     | 状態                                | 効果 / 次の確認                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Web / package Unit を変更 workspace に絞る                 | 実装済み（#2930）、使用量は未計測   | Product の related/full 判定と fail-closed を維持する                                                                   |
| Nightly full Unit は直近に実走した同一 SHA が成功なら省略  | 実装済み（#2930）、未計測・判定修正 | 新しい同一 SHA の全件テスト失敗時・手動実行・証拠取得失敗時は full suite を実行する                                     |
| Validation shadow / gate の自動実行を停止                  | GitHub UI で停止済み（2026-09-28）  | 週 997 分の自動実行を停止。required checks ではない。#2811 の gate 展開は別件として維持し、required checks に追加しない |
| 15 分 heartbeat Actions schedule を停止                    | 停止（push・日次監査は維持）        | 変更前は週 51 分。`/api/health/cron` の外形監視設定は未確認のため、push時・日次監査が残る                               |
| Storybook browser suite を story / dependency 影響時に限定 | 未実施                              | 週 117 分。安全な依存判定がないため full suite を維持し、誤 skip のリスクを取らない                                     |
| E2E を self-hosted runner へ切り替え                       | 選択肢のみ                          | runner 登録と変数設定は User 操作。[self-hosted-runner.md](../operations/self-hosted-runner.md)                         |
| Actions の追加課金予算                                     | `$0` / 上限時停止のまま             | 変更しない。枠を超える場合も超過課金は起こさず workflow が停止する                                                      |

**#2930 の CI 最適化は default branch に merge 済みだが、削減効果は未計測。Actions 使用量の再計測は保留する。** 後日計測する場合は、必須 checks を残した状態で 30 日換算 2,400 分以内を目標にし、`partial: true` の集計は判断に使わない。30 日分は API 上限と時間上限を守るため、週ごとに分割して集計する。

読み取り専用 collector: `node scripts/runbook/actions-usage-collector.mjs [--since YYYY-MM-DD --until YYYY-MM-DD] [--out FILE]`。既定で直近 7 完了 UTC 日を収集し、job の経過時間を個別に分単位へ切り上げ、Windows / macOS runner の quota multiplier を適用する。`--out` は既存ファイルを上書きしない。GitHub の billable usage report ではなく、私有化前の比較用推計である。

## 実測で分かった罠（検証と報告）

agent が実際に踏んで、緑の報告が嘘になった事例。どれもエラーを出さずに間違った結論を返す。2026-09-22 に Claude Code の memory から昇格した（provider を問わず効く）。

### 緑が証拠にならない形

- **パイプの末尾が exit code を隠す。** `pnpm check 2>&1 | tail -40` の exit code は `tail` のもので、失敗しても 0 が返る。検証主張に使う実行は `> <scratch>/check.log 2>&1; echo "EXIT=$?"` の形にし、`grep -E 'Test Files|Tests  '` で件数を読む（2026-08-11 #1934、2026-09-18 #2827 で 2 回誤報告した）
- **行数で切ると最重要部分が消える。** `| tail -N` / `| head -N` は行数が 1 行ずれた瞬間に必要な部分を落とし、残りが自己完結して見える。外部 CLI・レビュー出力は全量をファイルへ落としてから `sed -n '/^anchor/,$p'` のように内容で切る（2026-08-28、Codex の P1 2 件と marker の 1 行目を失った）
- **`pnpm typecheck` の cached は実走ではない。** turbo が `FULL TURBO` を返すと型検査は走らない。`pnpm check` も内部で同じ経路を通るので偽グリーンになる（2026-08-11 PR #1927）。確実なのは対象 package で `pnpm exec tsc --noEmit` を直接叩くこと。`--force` は 2 回目に tsc へ渡って `TS5093` で落ちることがある
- **skip 条件つき test の緑は実行の証拠ではない。** vitest の `it.skipIf` / `describe.skipIf` は収集時に評価されるので、`beforeAll` の probe で決まる条件は常に skip になる（2026-08-11 #1925 で 3 件全部 skip）。実行時条件は `it(name, (ctx) => { if (!ok) ctx.skip(); })` にし、`N passed` と `N skipped` を読み分け、有効・無効の両状態で 1 回ずつ走らせる
- **`::warning::` を出す関数を test から呼ぶと本物の annotation が出る。** GitHub Actions は vitest の stdout も workflow command として解釈する。全 PR に嘘の警告が出続けた（2026-09-16 PR #2788）。`vi.spyOn(console, 'log').mockImplementation(() => {})` で握ってから呼び、`gh run view <id> --log | rg '##\[warning\]'` で無いことを確認する
- **`.text-destructive` を含む複合 locator はエラー未発生でも即 pass する。** 必須項目の `＊` が送信前から可視なため。server error を待つ時は `[role="alert"][data-slot="field-error"]` まで絞り、文言を `toContainText` で確認する（2026-08-10 PR #1882、#1883）
- **`tsx` は top-level await を持つ `.mjs` を静的 import できない。** CJS へ落ちるので `ERR_REQUIRE_ASYNC_MODULE` で即死するが、vitest は ESM なので unit test は緑のまま。判定関数を注入する形にして CLI 側で `await import()` し、`spawnSync('pnpm', ['exec', 'tsx', ...])` の実起動 test を 1 本置く（2026-09-18 #2827）

### 環境と道具の癖

- **Node は 24 を前置する。** system の node 26 では zustand persist / localStorage 系 test が `Cannot read properties of undefined (reading 'clear')` で落ちる。`PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm check`（nvm / fnm は入っていない）。`env PATH=...` 形は PATH 中の空白で exit 127 になるので `export` する
- **`VAR=$(script)` の失敗は次のコマンドを止めない。** 空文字で `gh issue edit --body ""` が走り本文が消えた（2026-08-24）。上書き系は `|| exit` を付けるか、ファイルへ書いて非空を確認してから `--body-file` で渡す
- **`jq '.flag // "default"'` は `false` も既定値へ倒す。** boolean は `if (.x | type) == "boolean" then (.x | tostring) else "unknown" end` で読む。#2586 では約 40 件の test 失敗を「方針が広すぎる」と誤読した。大量失敗を設計の signal にする前に原因を 1 件掘る
- **自動整形が未使用 import を消す。** import を先に足して使用箇所を後で書くと、中間状態で lint-staged / 整形 hook が import を除去し、新機能が丸ごと無反応になる（2026-08-11 #1929）。使用箇所を先に書き、import は最後にまとめる。新しく足した処理が何も出力しない時はまず import の生存を見る
- **書き出したファイルに NUL が混ざると git が binary 扱いにして diff が読めなくなる。** `git diff --cached --stat` に `Bin 0 -> N bytes` と出たら疑う。`file <path>` が `data` なら `perl -i -pe 's/\x00/ /g'` で直す
- **`package.json` の依存を触ったら同じ commit に `pnpm-lock.yaml` を含める。** ローカルは既存 node_modules で素通りし、CI だけ全 job が setup で 15〜20 秒で落ちる（2026-09-07 PR #2623）。push 前に `pnpm install --frozen-lockfile` を通す。`catalog:` 化や依存 1 本の追加でも pnpm は無関係な version を再解決して動かすので、`git diff -U0 pnpm-lock.yaml | grep '^-' | grep -v '^---'` が空でなければ drift。旧 version へ手で戻してから `--frozen-lockfile` に検証させる（#2518、#2827）
- **新規 package に test を足したら root `test:run` の `&&` 連結へも足す。** turbo 任せではないので、忘れると CI で永久に走らない

### Cloud Preview の実行前照合（#2910、移行中）

`node scripts/runbook/preview-readiness.mjs` は、指定した Product Preview と非本番 DB の対応を読み取りで確認する。readiness 単独では E2E を起動せず、required check でもない。常設Integration DBとreadiness/DB keyのEnvironment登録は確認済みだが、Protection bypassの選択・実 Previewでの検証は未完了。この処理のunit test成功をログイン/CRUD実走の証拠にしない。

```bash
node scripts/runbook/preview-readiness.mjs \
  --sha <完全な候補SHA> --deployment <dpl_ID> \
  --branch <PRのbranch> --pr <PR番号> \
  --db-ref <非本番project_ref> --db-branch <Supabase branch UUID> \
  --db-mode <sharedまたはephemeral>
```

- 同じ SHA の clean checkout で実行する。期待 migration はその checkout から取得する。Supabase URL のみの指定や、可変 branch alias は対象選択に使わない。
- `GITHUB_TOKEN`（repositoryのdeployments/statuses read）、`SUPABASE_PREVIEW_READINESS_TOKEN`（branch/migration metadataだけの読取）、`VERCEL_AUTOMATION_BYPASS_SECRET` を許可済みrunnerの環境から渡す。引数・証拠 JSON・ログへ値を出さず、個人の Vault unlock をコマンドの前提にしない。初期の登録・scope確認は別途必要。
- GitHubが認証したVercel botの最新Product commit status/deployment statusで、Product path、Preview環境、exact SHA、requested deployment ID、成功状態、非Production flagを確認する。数値project IDは直接観測しない。Supabase は指定 parent/branch/ref、非 default、本番データ複製なしを確認する。`shared` は persistent、`ephemeral` は同じ PR/branch に属する使い捨て環境に限る。
- migration の version 集合は候補と完全一致を要求する。共有 DB に別候補の migration が入った場合も止まり、自動 reset・migration 適用・redeploy は行わない。version の一致は手動 DDL が無いことの証明ではない。
- Preview の `/api/health/version` が返す完全 SHA / deployment ID / DB ref、および `/api/health` の DB 疎通も照合する。本番の version 応答は従来どおり。欠測や古いアプリは未確認として失敗する。
- 成功JSONは識別子・migration versions・GitHub provider記録のID/発行者ID/時刻・観測開始/終了時刻だけを含む。全provider/DB/app観測が60秒を超える場合、時計が逆行・不正な場合は合格にしない。各サービスを原子的に読んだsnapshotではないため、`preview-e2e.mjs` はE2E前後に照合する。共有 DB の候補競合を防ぐ排他は別途必要。

非ローカルで service role を使う既存 E2E は `E2E_ALLOW_NONLOCAL_SUPABASE=1` に加え `E2E_SUPABASE_PROJECT_REF` を要求し、対応する HTTPS Supabase origin だけに接続する。これは上の readiness を代替しない。critical-path の synthetic user は実行ごとに password を生成し、作成成功を確認した同じ client/user だけを cleanup する。setup・cleanup の失敗は test を失敗させ、cleanup エラーには合成 user ID と失敗箇所だけを残す。remote run は実行開始前に `manifest.json` と `evidence/run.json` を保存し、`users/<UUID>.json` に作成前から状態を記録し、Auth の app_metadata に `e2e_run_id` を付ける。manifest/state/evidence は既定で `~/.local/state/dayopt/preview-e2e/<run UUID>/` に mode `0700/0600` で保存する。別の保存先を使うときだけ `E2E_PREVIEW_STATE_DIR` を明示する。manifestとuser記録にpassword、email、token、raw responseは保存しない。子プロセス終了後は `preview-cleanup.mjs` がjournal全件を先に検証し、Auth adminで同じrun ID・user ID・合成メールnamespaceが一致するユーザーだけを回収して削除後の不在を確認する。基準fixture・別run・Productionは対象外。

[Protection Bypass の公式仕様](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)に従い、readinessのbypass headerはGitHubの認証済みprovider記録で確認した具体deploymentのoriginだけへ送る。redirect は拒否する。ブラウザ全体への header 設定や query parameter への secret 埋込は使わない。[Playwright trace はネットワークも記録する](https://playwright.dev/docs/api/class-tracing)ため、remote E2E では生の Playwright trace/video/標準reportを保存先から除外する。代わりに下記の限定した操作記録を残す。通常CI/ローカルの既存traceは変更しない。

#### Remote E2E の実行

`node scripts/runbook/preview-e2e.mjs` に上記 readiness と同じ引数を渡す。さらに承認済み非本番の `SUPABASE_SECRET_KEY` が必要。readiness に成功した具体 deployment に対し、既存の desktop / mobile critical-path（作成・reload・Report確認）を実行し、終了後に再照合する。localhost の build / 起動はしない。個人の1Password認証も呼び出さない。run IDとstate directoryは実行開始時に出力される。既存CIからの明示opt-in経路は下記。実クラウドでの通し確認はまだ未完了。

- 子プロセスへは非本番DB keyと当該Previewのbypassだけを渡し、Vercel/Supabase管理tokenや他のアプリSecretは引き継がない。信頼できるコード・runnerでのみ実行する。未審査のforkへSecretを渡す仕組みではない。
- ブラウザ通信は具体Preview、選択したSupabase、CAPTCHA providerに限定する。本番domainを含むその他originは拒否する。bypassはPreviewだけへ1 hopずつ付け、redirect先で再判定する。
- 再試行は0、workerは1、Playwright全体5分。runnerの7分上限とSIGINT/SIGTERM時は自分が起動したprocess groupを停止し、private Playwright出力を削除する。子プロセス終了後にjournal cleanupを行い、その確認結果をpass条件に含める。SIGKILLやhost終了でcleanup前に停止した場合、process停止だけではDB上の合成user削除を保証しないため、下の回復経路を使う。
- 中断後の一覧は `node scripts/runbook/preview-e2e.mjs --list-recovery-runs`、明示したrunだけの回収は `node scripts/runbook/preview-e2e.mjs --recover-run <run UUID>`。**回収コマンドは現在の `origin/main` と完全一致するclean checkoutからのみ実行する。** コマンドが先に `origin/main` をfetchし、SHAとworking treeを照合する。回収時だけPRのOPEN・非Draft・現在head一致という新規実行条件を外すため、PRがclose/merge/head更新されても所有runを回収できる。内部repo・branch/baseと認証済みproviderの固定候補照合は維持する。回収処理は保存済み候補のdeployment/SHA/branch/DB ref/branch UUID/migration集合を再照合し、`running` / `recovering` の最後のheartbeatが10分以内なら停止する。`users/<UUID>.json` に列挙されたIDだけを対象にし、Auth user ID・`app_metadata.e2e_run_id`・critical-path用の合成emailが一致する場合に限って、そのuser IDの records/plans/activities/categories/user_settings/profiles とAuth userを消し、各テーブルとAuthの不在を確認する。Auth userが見つからない場合は各所有テーブルが既に0件かだけを確認し、残存行があれば所有を推測して削除せず手動確認で止める。失敗時はmanifestを保持して再試行可能にし、他run・基準fixture・未知ユーザー・DB全体には触れない。
- 成果物は表示された `evidenceDirectory` だけを収集する。`run.json` はrun IDと前後のreadiness・cleanupの確認件数/回収件数、`e2e.json` は操作のコード位置・時間・成否、通信先種別・HTTP status、失敗時PNGへの参照、`users/*.json` は合成ユーザーの状態、`recovery.json` はローカル回収したユーザーIDだけ。raw stdout/stderr、失敗メッセージ、入力値、URL query、header、cookie、通信bodyは出力しない。内部Playwright出力は終了後削除する。
- これはヘッダーやDOMを再現する通常のPlaywright traceではなく、資格情報を除外した限定的な操作記録。失敗の詳細は同じSHAのソース位置と失敗画面から追う。必要な情報が足りなければ、許可された非本番環境で範囲を絞って再現する。
- 終了コード0だけでは成功にしない。desktop/mobile両方の全対象testが初回成功し、skip/欠測/異常終了がなく、後段のreadinessも一致し、2ユーザー以上のjournal全件で削除後の不在を確認した時だけ `passed`。この結果を既存Validationが信頼済み証拠として受理する配線は別途必要。

### Cloudの明示実行（既存CI）

GitHub Actionsの既存 `CI` → `Run workflow` でworkflow branchを **integration** にし、`preview_e2e=true` を指定する。PR番号・レビュー済み候補SHA・READY deployment ID・DB mode/ref/branch UUIDを全て明示する。通常のPR CIとmainのrelease経路は維持し、Cloud E2Eは独立したrunとして起動する。通常実行では `preview_recover_run` / `preview_recover_attempt` を空のままにする。default branchには既に `ci.yml` のdispatch入口がある。Integrationの新しい入力定義がUI/APIで実際に起動できるかは配線後に確認する。

Secret取得前のread-only gateはOPEN・非Draft・同一repo PR・exact head SHA・許可したbase/head branchを確認する。共有モードは既存Persistentのref/UUIDに限定し、`supabase/**` が変わるPRを拒否する。隔離モードは本番・Persistentを拒否し、既存readinessがPR専用branchとの対応を照合する。gateはコードの無害性を証明しない。権限ある担当が対象コードと依存をレビューしてSHAを選び、明示dispatchする。同一workerでのinstall-before-secretsは完全なsandboxではない。未信頼のcandidateは実行しない。

既存GitHub Environment **Preview – product** は、初回の管理資格情報保存前にDeployment branches/tagsを **Selected branches and tags**、許可を **branch integrationのみ** に限定する。trust gateはこの制限をAPIで照合し、unrestricted・追加branch/tag・観測失敗を拒否する。現在は `integration` のみ許可する設定を保存・確認済み。ユーザーの明示指示によりagentが設定保存を行えるが、個人Vault・1Passwordを開かず、値を会話へ出さない。

このEnvironmentの長寿命Secretは必要なexecute/cleanup stepにだけ注入する。repository-wide secretやProductionの同名値で代用しない。`PREVIEW_E2E_SUPABASE_READINESS_TOKEN` と `PREVIEW_E2E_SUPABASE_KEY` はEnvironmentへの直接保存をUIで確認済みで、1Password masterの初期化・同期を証明するものではない。Protection bypassの権限境界は未決のため、保存・実走完了とは扱わない。

- `GITHUB_TOKEN`（`${{ github.token }}`）: trusted workerの短寿命token。`deployments: read` と `statuses: read` でGitHubにVercelが発行したProduct Previewのdeployment/statusを読む。長寿命Vercel PATはPreviewへ保存・注入しない。候補Playwrightの環境へGitHub tokenを渡さない。
- `PREVIEW_E2E_SUPABASE_READINESS_TOKEN`（workerでは `SUPABASE_PREVIEW_READINESS_TOKEN`）: branch一覧と選択した非本番DBのmigration metadata確認用。fine-grained tokenは **Development Branches Read**（`branching_development_read`）と **Migrations Read**（`database_migrations_read`）だけを付け、Database Data Readやwrite権限は付けない。migration確認は `GET /v1/projects/{ref}/database/migrations` を使い、SQLへfallbackしない。branch選択UIが子projectを提供しない場合は親projectを選ぶため、親のbranch/migration metadataへ到達できる権限であり非本番projectだけの権限とは呼ばない。選択した子projectへ同tokenでGETできることは初回実走で確認し、403では権限を広げず停止する。
- `PREVIEW_E2E_BYPASS_SECRET`（workerでは `VERCEL_AUTOMATION_BYPASS_SECRET`）: Product PreviewのProtection用。現在は方式・保存が未決。project単位bypassは同じProduct projectのProductionにも到達し得るため、非本番だけの資格情報とは扱わない。対象Previewだけのshare方式との選択は所有者判断を待つ。アプリへの正規ログインは省略しない。
- `PREVIEW_E2E_SUPABASE_KEY`（workerでは `SUPABASE_SECRET_KEY`）: 選択した非本番DBの合成user作成・所有runの回収用。隔離DBを選ぶ場合は対象DBのkeyが必要で、共有DBのkeyへfallbackしない。

Vercel側のreadinessは数値project IDのAPI照合から、GitHubが認証した `vercel[bot]`（ID `35613825`）・Product path `/dayopt/product/`・`Preview – product` 環境・本番flag false・exact SHA・requested deployment ID・immutable originの契約へ置き換える。最新Product commit statusと最新deployment statusの成功を要求し、古い成功へのfallbackや曖昧な再デプロイ対応を拒否する。アプリの自己申告だけで合格にせず、同originのlive SHA/deployment ID/DB refとhealthを前後確認する。これは数値Vercel project IDの直接観測ではない。APIの観測失敗・発行者違い・別Product/環境・候補の変更はuser作成前に停止する。

候補checkout前に、run UUID・desktop/mobileの予定user ID・GitHub run/attempt・trusted workflow SHA・候補/DB bindingだけの `preview-intent-<run>-<attempt>` artifactを保存する。password/keyは含まない。候補のfixture生成2ファイルはtrusted workflowの契約と一致することを要求し、古い候補が予定IDを無視する場合はAuth作成前に停止する。候補checkoutと依存・Chromiumのinstallを終えてからlive PRを再照合し、選択した非本番Authの基準合成ユーザーへのadmin GETでkeyを認証する。legacy keyのrole/refが違う場合、opaque keyの認証失敗、基準fixture欠落はいずれもuser作成前に停止する。providerの応答やメールアドレスは公開しない。続いて、信頼済みIntegrationのsupervisorで既存desktop/mobile critical pathを実行する。runごとに別concurrency groupとfixtureを持ち、他のrunを自動cancelしない。終了・失敗・cancelでは、生きているworker上の `always()` stepが所有journalだけを再回収する。Playwrightは5分、supervisorは7分、回収は120秒以内、jobは20分。VM破棄・job強制終了でこのstepが実行できない場合は、以下の別worker回収入口を使う。共有schema更新の排他leaseも未実装で、前後readinessはdriftの検出まで。

通常E2Eの結果artifactは信頼済みコードで再構成した **preview.jsonだけ**。候補SHA/deployment/DB、run ID、testのファイル・行・成否、所有user ID/statusと確認フラグを含む。画像、private出力、生のJSON、error本文、title、入力値、header/cookie/bodyをuploadしない。Cloud実走・2run並列・中断回収・次のPRでの再利用は実測後に証拠を記録し、配線やunit testだけでは完了扱いにしない。

### Worker消失後の限定回収

同じ `CI` → `Run workflow` でworkflow branchを **integration**、`preview_e2e=true` とし、`preview_recover_run` / `preview_recover_attempt` に元の失敗run IDとattemptを指定する。PR/SHA/deployment/DB入力を再入力して回収対象を推測しない。信頼済みコードが、元run/対象attemptの完了・失敗、開始済みE2E step、元repo/workflow/ref/SHA、候補コード前に保存した一意なintent artifactをAPIで照合する。最新attemptが稼働中、元の成功、証拠不足、artifact期限切れ・置換・欠測では停止する。

回収intent artifactはread-only GitHub tokenで、元run/attemptに結び付いたartifact IDを指定して取得する。`gh api` の応答ZIPは128KiB以内でメモリに保持し、展開前にREST metadataのSHA-256 digestと一致することを確認する。ZIPから読むのはroot直下の `intent.json` 1件だけで、16KiBを超える内容、追加entry、path、symlink、暗号化、破損した圧縮データを拒否し、ファイルシステムへ展開しない。取得前後のartifact ID/digestを再照合する。candidate codeは回収workerでcheckout/実行しない。資格情報を使う直前にも元run/APIを再確認し、選択した非本番Authでkeyを認証する。

回収workerはintentの予定2IDだけの一時journalを再構成し、既存の回収関数で各IDをGETする。404は未作成/削除済みとして確認し、存在する場合はserver側run所有権と合成メール形式を確認してからDELETE→404確認を行う。他のAuthユーザーを一覧検索しない。同じ元run/attemptの回収は直列化し、別attemptには新しいIDを割り当てる。公開する `recovery.json` は元binding・予定ID・結果だけで、provider本文・メール・credentialsを含まない。

これは明示dispatchによる別worker回収の入口で、VM消失の自動検知/起動まで接続したものではない。7日のartifact保持を過ぎた回収は証拠不足で止まる。ephemeralを回収する場合にも**元DBのkey**が必要で、Environmentに現在保存されている共有DBのkeyへfallbackしない。keyが変わった場合の再保存は所有者が行う。Cloudでのhard-loss・別attempt・並列2runの実証は未完で、unit testや配線だけを成功証拠にしない。

### ローカル E2E とブラウザ実測

- **login 系 E2E をローカルで走らせるには env 4 点を渡す。** `.env` は読まず `supabase status -o json` から鍵を取る。渡さないと `resolveServiceRoleTarget` が false になり suite ごと skip して「0 failed」の緑に見える（`4 skipped` を確認する）

  ```bash
  NEXT_PUBLIC_TURNSTILE_SITE_KEY= \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
  SUPABASE_SECRET_KEY="$SECRET_KEY" \
  pnpm exec playwright test <spec> --project=chromium --reporter=line
  ```

  Turnstile が出て `button[type="submit"]` が disabled のまま落ちるのは環境差。`@next/env` は定義済みの `process.env` を上書きしないので、shell 側の空文字が勝つ。空文字にしても落ちるなら Supabase の anon key が remote のまま（画面には理由が出ない）

- **Turnstile の 2 経路は公式 test key で踏める。** `3x00000000000000000000FF` は強制対話（submit が disabled のまま）、無効文字列は error 400020（submit が有効化）。site key を差し替えて dev server を立て直すだけで 5 分で確認できる
- **env ファイルの無い worktree でも dev は動く。** `env NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<...> SUPABASE_SECRET_KEY=<...> NEXT_PUBLIC_APP_URL=http://localhost:3200 NEXT_PUBLIC_TURNSTILE_SITE_KEY= pnpm --filter @dayopt/product exec next dev -p 3200`。Resend / Upstash / Sentry / Turnstile は未設定の既知の状態。seed ユーザーへはパスワードを打たず magic link で入る（`POST /auth/v1/admin/generate_link` の `hashed_token` を `/ja/auth/confirm?token_hash=<hash>&type=magiclink&next=/calendar` へ）。translation key を足したら dev server を再起動しないと `MISSING_MESSAGE` が出続ける。Next は同一ディレクトリの 2 つ目の `next dev` を拒否するので、`lsof -nP -iTCP:3000 -sTCP:LISTEN` で既に立っていればそれを使う
- **dev の HSTS が localhost にも効く。** `next.config.mjs` の `Strict-Transport-Security` は環境を問わず出るため、内蔵 Chrome で言語切替の RSC fetch が `ERR_SSL_PROTOCOL_ERROR` になる。full navigation にフォールバックして成立するので diff 由来と誤診しない
- **module state が遷移を跨ぐ前提の P1 は hard navigation か測ってから重さを決める。** 遷移前に `window.__probe = 'x'` を置き、遷移後に消えていれば store ごと reset されている。2026-09-18 の auth レビューで「再ログインが弾き戻される」P1 が実測で潜在へ降格した。修正自体は残してよいが、報告では「潜在」と書く
- **429 を trace で数える。** `--trace on` の `test-results/*/trace.zip` 内 `*.network` から `/api/trpc/<a,b,c>?batch=1` を分解すると test ごとの手続き数が出る。rate limit は手続き単位なので、直列 spec は 1 テスト 40〜70 手続きで 100/min に素で届く（#2669）。commit 違いの比較は `git worktree add --detach` で。削除済み worktree の next-server が port 3000 に残ると `reuseExistingServer` で別コードを叩くので先に `lsof` で cwd を見る
- **`next start` は `RECOVERY_CODE_PEPPER` 必須。** build は通り、最初のリクエストで 500 になる。local 計測ならダミー値を起動 script 内で export する（repo には入れない）。web は `networkidle` に到達しないので load + 固定待ちにする。`~/Library/Caches/ms-playwright` が消えたら `pnpm exec playwright install chromium chromium-headless-shell`
- **他 session が作った PR は既存 worktree で再検証できる。** `git worktree list` で対象 branch の worktree（node_modules 済み）を探し、`git status --short` が空で HEAD が `headRefOid` と一致すれば vitest をそこで叩くだけでよい。read-only 操作に限り、dev server や E2E は回さない（生成物で他 lane の worktree を汚す）
- **Mermaid は headless で parse 検証する。** `apps/storybook/node_modules/mermaid/dist/mermaid.core.mjs` を happy-dom の `Window` 上で import し `mermaid.parse(code)` を呼ぶ。diagramType が返れば構文 OK（#2775）
