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

repo を private に戻すと、Actions は分単位の課金になる。GitHub Team（$4/seat/月）で ruleset の merge gate を維持し、無料枠は 3,000 分/月。超過は $0.008/分。

実測（2026-09-14、job ごとに分を切り上げて集計）:

| workflow                    | 直近 30 日 | 主な job（30 日）                                                           |
| --------------------------- | ---------: | --------------------------------------------------------------------------- |
| ci.yml                      |   3,399 分 | Unit 1,484 / Static 998 / Integration 643                                   |
| promote.yml                 |     808 分 | E2E 569 / Web E2E 94                                                        |
| production-config-audit.yml |     684 分 | 1 分未満の job 4 本 × 分の切り上げ                                          |
| nightly.yml                 |     125 分 |                                                                             |
| 合計                        |   5,017 分 | 直近 7 日の回数（PR push 100 / main push 57）で換算すると月 7,000〜8,000 分 |

消費を決めるのは 1 run の重さより回数。置き場所の規則:

- **per-PR の job は 1 本 6 分以内**。重いものを per-PR に足さない
- **main push の層 3 job は 1 本 10 分以内**。mobile E2E は既存の e2e job に同居させる（build と webServer を共有）
- **新しい job より既存 job の step**。1 分未満の job も 1 分に切り上がる
- **コードが変わらなくても変わるものだけを nightly に置く**

### 予算レバー台帳

| レバー                                                | 状態                      | 効果の見込み                                   | 備考                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR の product unit を related に絞り、nightly で full | 実施（#2743）             | 月 300〜800 分減（nightly 150 分を差し引き前） | 結果(未): merge 後 2 週間の Unit job 所要で確かめる                                                                                                          |
| promote の e2e job を self-hosted runner へ           | 切替手段のみ実施（#2743） | 月 600〜1,000 分減                             | runner 登録と変数設定は User 操作。[self-hosted-runner.md](../operations/self-hosted-runner.md)                                                              |
| mobile 中核 E2E を promote に追加                     | 実施（#2743）             | 月 75〜110 分増                                | 増分                                                                                                                                                         |
| promote 層 3 の cancel-in-progress                    | 実施済み（既存）          | —                                              |                                                                                                                                                              |
| audit の Supabase 2 job を 1 job に統合               | 見送り                    | 月 100 分程度                                  | job 名を鍵にした security contract test 2 本の書き換えが要り、節約に見合わない。deploy-health は commit status 権限を持つので token 分離上そもそも統合しない |
| Static と Unit の 1 job 化                            | 見送り                    | 月 200 分程度                                  | ruleset の required check 名が変わる                                                                                                                         |
| org の Actions spending limit を $0 から上げる        | User 操作                 | —                                              | 上限 $0 のまま枠を使い切ると CI が起動しなくなり、merge gate ごと止まる                                                                                      |

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

`node scripts/runbook/preview-readiness.mjs` は、指定した Product Preview と非本番 DB の対応を読み取りで確認する。readiness 単独では E2E を起動せず、required check でもない。常設 DB 登録・資格情報配布・実 Preview での検証は未完了であり、この処理の unit test 成功を環境稼働の証拠にしない。

```bash
node scripts/runbook/preview-readiness.mjs \
  --sha <完全な候補SHA> --deployment <dpl_ID> \
  --branch <PRのbranch> --pr <PR番号> \
  --db-ref <非本番project_ref> --db-branch <Supabase branch UUID> \
  --db-mode <sharedまたはephemeral>
```

- 同じ SHA の clean checkout で実行する。期待 migration はその checkout から取得する。Supabase URL のみの指定や、可変 branch alias は対象選択に使わない。
- `VERCEL_TOKEN`（対象 project の読取）、`SUPABASE_PREVIEW_READINESS_TOKEN`（branch metadata / 対象非本番 DB の読取）、`VERCEL_AUTOMATION_BYPASS_SECRET` を許可済み runner の環境から渡す。引数・証拠 JSON・ログへ値を出さず、個人の Vault unlock をコマンドの前提にしない。初期の登録・scope確認は別途必要。
- Vercel API が返す具体 deployment の project、Git source、SHA、READY、非 production target を確認する。Supabase は指定 parent/branch/ref、非 default、本番データ複製なしを確認する。`shared` は persistent、`ephemeral` は同じ PR/branch に属する使い捨て環境に限る。
- migration の version 集合は候補と完全一致を要求する。共有 DB に別候補の migration が入った場合も止まり、自動 reset・migration 適用・redeploy は行わない。version の一致は手動 DDL が無いことの証明ではない。
- Preview の `/api/health/version` が返す完全 SHA / deployment ID / DB ref、および `/api/health` の DB 疎通も照合する。本番の version 応答は従来どおり。欠測や古いアプリは未確認として失敗する。
- 成功 JSON は識別子・migration versions・観測開始/終了時刻のみ。各サービスを原子的に読んだ snapshot ではないため、`preview-e2e.mjs` は E2E 前後に照合する。共有 DB の候補競合を防ぐ排他は別途必要。

非ローカルで service role を使う既存 E2E は `E2E_ALLOW_NONLOCAL_SUPABASE=1` に加え `E2E_SUPABASE_PROJECT_REF` を要求し、対応する HTTPS Supabase origin だけに接続する。これは上の readiness を代替しない。critical-path の synthetic user は実行ごとに password を生成し、作成成功を確認した同じ client/user だけを cleanup する。setup・cleanup の失敗は test を失敗させ、cleanup エラーには合成 user ID と失敗箇所だけを残す。remote run は `users/<UUID>.json` に作成前から状態を記録し、Auth の app_metadata に `e2e_run_id` を付ける。中断・応答喪失・cleanup失敗後は、この記録と対象非本番DBのユーザーID・app_metadataの一致を確認して回収する。未知の既存ユーザーを推測で削除しない。中断後の自動回収は未実装。

[Protection Bypass の公式仕様](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)に従い、readiness の bypass header は API で確認した具体 deployment の origin だけへ送る。redirect は拒否する。ブラウザ全体への header 設定や query parameter への secret 埋込は使わない。[Playwright trace はネットワークも記録する](https://playwright.dev/docs/api/class-tracing)ため、remote E2E では生の Playwright trace/video/標準reportを保存先から除外する。代わりに下記の限定した操作記録を残す。通常CI/ローカルの既存traceは変更しない。

#### Remote E2E の実行

`node scripts/runbook/preview-e2e.mjs` に上記 readiness と同じ引数を渡す。さらに承認済み非本番の `SUPABASE_SECRET_KEY` が必要。readiness に成功した具体 deployment に対し、既存の desktop / mobile critical-path（作成・reload・Report確認）を実行し、終了後に再照合する。localhost の build / 起動はしない。個人の1Password認証も呼び出さない。実クラウドでの通し確認とCIへの配線はまだ未完了。

- 子プロセスへは非本番DB keyと当該Previewのbypassだけを渡し、Vercel/Supabase管理tokenや他のアプリSecretは引き継がない。信頼できるコード・runnerでのみ実行する。未審査のforkへSecretを渡す仕組みではない。
- ブラウザ通信は具体Preview、選択したSupabase、CAPTCHA providerに限定する。本番domainを含むその他originは拒否する。bypassはPreviewだけへ1 hopずつ付け、redirect先で再判定する。
- 再試行は0、workerは1、Playwright全体5分。runnerの7分上限後は自分が起動したprocess groupを終了させる。これでDB上の合成データも自動的に消えるとはみなさず、下の残存記録を確認する。
- 成果物は表示された `evidenceDirectory` だけを収集する。`run.json` はrun IDと前後のreadiness、`e2e.json` は操作のコード位置・時間・成否、通信先種別・HTTP status、失敗時PNGへの参照、`users/*.json` は合成ユーザーの状態。raw stdout/stderr、失敗メッセージ、入力値、URL query、header、cookie、通信bodyは出力しない。内部Playwright出力は終了後削除する。
- これはヘッダーやDOMを再現する通常のPlaywright traceではなく、資格情報を除外した限定的な操作記録。失敗の詳細は同じSHAのソース位置と失敗画面から追う。必要な情報が足りなければ、許可された非本番環境で範囲を絞って再現する。
- 終了コード0だけでは成功にしない。desktop/mobile両方の全対象testが初回成功し、skip/欠測/異常終了がなく、後段のreadinessも一致した時だけ `passed`。この結果を既存Validationが信頼済み証拠として受理する配線は別途必要。

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
