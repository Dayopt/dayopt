---
status: current
last_verified: 2026-09-16
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

| 層                            | 証明すること                                 | Dayopt の例                                         | 回る場所                       |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| Static                        | コードとして成立している                     | typecheck / lint / boundaries / knip                | pre-push、PR（ci.yml）         |
| Unit（Vitest）                | 小さなロジックが正しい                       | 時刻計算、重なり判定、集計、状態遷移                | PR は related、nightly で full |
| Storybook + Vitest            | UI 部品の状態・操作・a11y                    | editor、activity picker、Report 部品                | main push（promote.yml 層 3）  |
| Integration（local Supabase） | 部品・DB・API をつないでも正しい             | RLS、RPC、migration 契約                            | DB を触る PR（ci.yml）         |
| E2E（Playwright）             | ユーザーが中核の目的を end-to-end で達成する | Plan → Record → reload → Report（desktop / mobile） | main push（promote.yml 層 3）  |
| 契約 / 監査                   | 横断リスク                                   | workflow contract、production config audit          | PR / main push / 日次          |
| 探索（dogfooding）            | まだ知らない問題                             | 迷い、余計な一手、状態不整合                        | オンデマンド（gate にしない）  |

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
